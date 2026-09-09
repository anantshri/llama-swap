# Intel dGPU reported "Shared System" instead of VRAM size

## Symptom

On dumbo (Intel graphics host), the llama-swap Hardware page showed the
GPU's memory as "Shared System" with no capacity, while `xpu-smi` on the
same host reports 32 GB VRAM clearly.

## Diagnosis

`internal/hw` detects accelerators on Linux via three probes:
`nvidia-smi`, `rocm-smi`/KFD (AMD), and a generic DRM/sysfs walk. The sysfs
walk (`detectDRMSysfs` in `detect_linux.go`) defaults every device to
`shared_system` and only marks it `dedicated` when
`/sys/class/drm/cardN/device/mem_info_vram_total` is readable and nonzero.
The Intel driver stack on dumbo does not expose that file, so the discrete
card fell into the integrated-GPU bucket. There was no Intel-specific CLI
probe to fall back on — `intel.go` only maps PCI device IDs to
architecture/model names.

## Change

- **`internal/hw/intel_linux.go`** (new): `detectIntel` probe.
  - `xpu-smi discovery -j` lists devices (`device_list[].device_id`,
    `pci_bdf_address`).
  - `xpu-smi discovery -d <id> -j` per device fetches full detail — the
    bare listing omits memory. Fields used: `device_name`, `device_type`
    ("Discrete GPU" / "Integrated GPU"), `driver_version`,
    `memory_physical_size_byte` (bytes).
  - Discrete → `AcceleratorMemory{Kind: "dedicated", CapacityBytes: ...}`;
    `device_type` containing "integrated" → `shared_system` (capacity left
    unset — it is the same physical RAM as system memory).
  - Driver recorded as `xe` + xpu-smi's `driver_version` string.
  - Identity = normalized PCI BDF, merging with the sysfs record:
    `finalizeAccelerators` keeps the first record's non-null fields, and
    `detectPlatform` orders probes NVIDIA → AMD → Intel → sysfs, so
    xpu-smi's dedicated+capacity wins while sysfs still contributes
    architecture (from the PCI-ID table) and power limit.
- **`internal/hw/detect_linux.go`**: `detectDRMSysfs` →
  `detectDRMSysfsFrom(sysRoot)`; `hasAccessibleRenderNode` takes the
  `/dev/dri` root. No behavior change on a real host; enables the
  fixture-based sysfs test.
- **`docs/gosec-suppressions.md`**: G204 ×8 (total 92) — the `xpu-smi`
  call is a fixed system binary with an integer device index.
- **`internal/hw/README.md`**: probe table + file layout updated.

### Diff summary

```
internal/hw/intel_linux.go       | new, ~115 lines (probe + JSON mapping)
internal/hw/intel_linux_test.go  | new, 7 tests
internal/hw/detect_linux.go      | +detectIntel in detectPlatform;
                                  | detectDRMSysfsFrom/hasAccessibleRenderNode roots
internal/hw/README.md            | probe docs
docs/gosec-suppressions.md       | ledger update
```

## Commands

- `go test -v -run "TestHardware_Intel" ./internal/hw/` — 7 passed
- `make test-dev` — ok (go test + staticcheck)
- `make gosec` — 0 issues across linux/darwin/windows
- `go test -cover ./...` — 1501 passed in 31 packages
- `aidc-scan` — clean

## Verification

Parser/merge behavior is covered by captured-JSON tests (no Intel hardware
in CI). Live check on dumbo after deploying the rebuilt binary: the Arc/
Flex card should show "Dedicated" with ~32 GB from
`memory_physical_size_byte`. xpu-smi JSON field names were verified
against intel/xpumanager's `ial/cmn/cmd_discovery.cpp` (device_list shape,
per-device dump shape, byte-unit memory field, and the "Discrete GPU" /
"Integrated GPU" device_type strings).

## Notes

- If xpu-smi is absent or fails, behavior is unchanged from before (sysfs
  result stands).
- xpu-smi discovery may need elevated privileges on some hosts (Intel
  documents `sudo xpu-smi discovery`); if it fails without root the probe
  silently contributes nothing — same graceful degradation as the other
  CLI probes.
