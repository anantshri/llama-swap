//go:build linux

package hw

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const xpusmiListing = `{
  "device_list": [
    {
      "device_function_type": "physical",
      "device_id": 0,
      "device_name": "Intel(R) Data Center GPU Flex 170",
      "device_state": "Normal",
      "device_type": "Discrete GPU",
      "drm_device": "/dev/dri/card1",
      "pci_bdf_address": "0000:4d:00.0",
      "pci_device_id": "0x56c0",
      "uuid": "00000000-0000-0000-6769-df256e271362",
      "vendor_name": "Intel(R) Corporation"
    }
  ]
}`

const xpusmiDeviceDetail = `{
  "device_id": 0,
  "device_name": "Intel(R) Data Center GPU Flex 170",
  "device_type": "Discrete GPU",
  "driver_version": "XE_1.0.4_23.4.15",
  "pci_bdf_address": "0000:4d:00.0",
  "memory_physical_size": "14248.00 MiB",
  "memory_physical_size_byte": 14942253056
}`

func TestHardware_IntelXPUSMIDeviceParsing(t *testing.T) {
	var device xpusmiDevice
	if err := json.Unmarshal([]byte(xpusmiDeviceDetail), &device); err != nil {
		t.Fatal(err)
	}
	got := xpusmiRecordToAccelerator(device, "0000:4d:00.0")

	if got.identity != "0000:4d:00.0" {
		t.Errorf("identity = %q, want 0000:4d:00.0", got.identity)
	}
	if stringValue(got.value.Vendor) != "Intel" {
		t.Errorf("vendor = %q, want Intel", stringValue(got.value.Vendor))
	}
	if stringValue(got.value.Model) != "Intel(R) Data Center GPU Flex 170" {
		t.Errorf("model = %q", stringValue(got.value.Model))
	}
	if got.value.Memory.Kind != "dedicated" {
		t.Errorf("memory kind = %q, want dedicated", got.value.Memory.Kind)
	}
	if got.value.Memory.CapacityBytes == nil || *got.value.Memory.CapacityBytes != 14942253056 {
		t.Errorf("memory capacity = %v, want 14942253056", got.value.Memory.CapacityBytes)
	}
	if got.value.Driver == nil || stringValue(got.value.Driver.Version) != "XE_1.0.4_23.4.15" {
		t.Errorf("driver = %+v", got.value.Driver)
	}
}

func TestHardware_IntelXPUSMIIntegratedKeepsSharedSystem(t *testing.T) {
	detail := `{
  "device_id": 1,
  "device_name": "Intel(R) Graphics",
  "device_type": "Integrated GPU",
  "driver_version": "i915",
  "pci_bdf_address": "0000:00:02.0",
  "memory_physical_size_byte": 8589934592
}`
	var device xpusmiDevice
	if err := json.Unmarshal([]byte(detail), &device); err != nil {
		t.Fatal(err)
	}
	got := xpusmiRecordToAccelerator(device, "0000:00:02.0")
	if got.value.Memory.Kind != "shared_system" {
		t.Errorf("memory kind = %q, want shared_system", got.value.Memory.Kind)
	}
}

func TestHardware_IntelXPUSMIMissingMemoryStaysDedicatedWithoutCapacity(t *testing.T) {
	// Older xpu-smi builds omit memory fields; kind stays dedicated for a
	// discrete card but capacity stays unset rather than inventing a value.
	detail := `{
  "device_id": 0,
  "device_name": "Intel(R) Arc(TM) A770 Graphics",
  "device_type": "Discrete GPU",
  "pci_bdf_address": "0000:03:00.0"
}`
	var device xpusmiDevice
	if err := json.Unmarshal([]byte(detail), &device); err != nil {
		t.Fatal(err)
	}
	got := xpusmiRecordToAccelerator(device, "0000:03:00.0")
	if got.value.Memory.Kind != "dedicated" || got.value.Memory.CapacityBytes != nil {
		t.Errorf("memory = %+v, want dedicated with nil capacity", got.value.Memory)
	}
}

func TestHardware_IntelXPUSMIDiscoveryFallsBackToDetailBDF(t *testing.T) {
	// The listing's BDF is used when the detail query fails or omits it;
	// xpusmiRecordToAccelerator receives the identity from detectXPUSMI, so
	// verify normalizePCIIdentity handles the 0000:4d:00.0 shape used by
	// xpu-smi (already domain-qualified).
	if got := normalizePCIIdentity("0000:4d:00.0"); got != "0000:4d:00.0" {
		t.Errorf("normalizePCIIdentity() = %q, want unchanged", got)
	}
}

func TestHardware_IntelXPUSMIAbsent(t *testing.T) {
	// On machines without xpu-smi (or without PATH access), detection must
	// silently contribute nothing.
	if got := detectIntel(context.Background()); got != nil {
		t.Errorf("detectIntel() = %+v, want nil without xpu-smi", got)
	}
}

func TestHardware_IntelXPUSMIMergesOverSysfsSharedSystem(t *testing.T) {
	// The end-to-end fix: a discrete Arc card that sysfs reported as
	// shared_system (no mem_info_vram_total) must end up dedicated with the
	// xpu-smi capacity after finalizeAccelerators merges the two records.
	var device xpusmiDevice
	if err := json.Unmarshal([]byte(xpusmiDeviceDetail), &device); err != nil {
		t.Fatal(err)
	}
	xpusmi := xpusmiRecordToAccelerator(device, "0000:4d:00.0")
	sysfs := detectedAccelerator{
		identity: "0000:4d:00.0",
		value: Accelerator{
			Kind:         "gpu",
			Vendor:       stringPtr("Intel"),
			Architecture: stringPtr("Alchemist"),
			Memory:       AcceleratorMemory{Kind: "shared_system"},
		},
	}

	got := finalizeAccelerators([]detectedAccelerator{xpusmi, sysfs})
	if len(got) != 1 {
		t.Fatalf("finalizeAccelerators() returned %d devices, want 1: %+v", len(got), got)
	}
	accel := got[0]
	if accel.Memory.Kind != "dedicated" {
		t.Errorf("merged memory kind = %q, want dedicated", accel.Memory.Kind)
	}
	if accel.Memory.CapacityBytes == nil || *accel.Memory.CapacityBytes != 14942253056 {
		t.Errorf("merged memory capacity = %v, want 14942253056", accel.Memory.CapacityBytes)
	}
	if stringValue(accel.Architecture) != "Alchemist" {
		t.Errorf("merged architecture = %q, want Alchemist (sysfs contribution preserved)", stringValue(accel.Architecture))
	}
}

func TestHardware_IntelSysfsDiscreteWithoutXPUSMI(t *testing.T) {
	// Regression guard for the pure-sysfs path: with mem_info_vram_total
	// present the card already reports dedicated; without xpu-smi nothing
	// changes for it. Layout mirrors /sys: class/drm/cardN -> pci device,
	// and dev/dri carrying the render node.
	root := t.TempDir()
	sysfsDRM := filepath.Join(root, "class", "drm")
	devicePath := filepath.Join(root, "pci", "0000:4d:00.0")
	for _, path := range []string{
		filepath.Join(sysfsDRM, "card1"),
		filepath.Join(devicePath, "drm", "renderD128"),
		filepath.Join(root, "dev", "dri"),
	} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range map[string]string{
		"vendor":              "0x8086\n",
		"device":              "0x56c0\n",
		"mem_info_vram_total": "14942253056\n",
	} {
		if err := os.WriteFile(filepath.Join(devicePath, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(devicePath, filepath.Join(sysfsDRM, "card1", "device")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dev", "dri", "renderD128"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := detectDRMSysfsFrom(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("detectDRMSysfsFrom() = %+v, want 1 device", got)
	}
	if got[0].value.Memory.Kind != "dedicated" || got[0].value.Memory.CapacityBytes == nil {
		t.Errorf("sysfs memory = %+v, want dedicated with capacity", got[0].value.Memory)
	}
	if stringValue(got[0].value.Architecture) != "Alchemist" {
		t.Errorf("sysfs architecture = %q, want Alchemist (0x56c0 = ATS-M)", stringValue(got[0].value.Architecture))
	}
}
