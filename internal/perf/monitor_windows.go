package perf

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/mostlygeek/llama-swap/internal/logmon"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

func getGpuStats(ctx context.Context, every time.Duration, logger *logmon.Monitor) (chan []GpuStat, error) {
	if ch, err := tryNvidiaSmiWindows(ctx, every, logger); err == nil {
		logger.Info("using nvidia-smi for GPU monitoring")
		return ch, nil
	} else {
		logger.Debugf("nvidia-smi: %s", err.Error())
	}

	return nil, ErrNoGpuTool
}

// tryNvidiaSmiWindows starts nvidia-smi in loop mode on Windows and returns
// a channel receiving GPU stat snapshots. Returns ErrNoGpuTool if nvidia-smi
// is not available.
func tryNvidiaSmiWindows(ctx context.Context, every time.Duration, logger *logmon.Monitor) (chan []GpuStat, error) {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return nil, ErrNoGpuTool
	}

	sec := int(every.Seconds())
	if sec < 1 {
		sec = 1
	}

	// #nosec G204 -- literal binary name, literal flag strings, single numeric format arg; no shell expansion
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,name,uuid,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw",
		"--format=csv,noheader,nounits",
		"--loop", fmt.Sprintf("%d", sec),
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("nvidia-smi stdout pipe failed: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("nvidia-smi start failed: %w", err)
	}

	ch := make(chan []GpuStat, 1)

	go func() {
		defer close(ch)

		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}

			stat := ParseNvidiaSmiLine(line)
			if stat != nil {
				select {
				case ch <- []GpuStat{*stat}:
				default:
				}
			}
		}
		_ = cmd.Wait()
	}()

	return ch, nil
}

func readSysStats() (SysStat, error) {
	cpuPcts, err := cpu.Percent(0, true)
	if err != nil {
		return SysStat{}, err
	}

	vmStat, err := mem.VirtualMemory()
	if err != nil {
		return SysStat{}, err
	}

	const toMB = 1024 * 1024

	netIO := make([]NetIOStat, 0)
	if ioCounters, err := net.IOCounters(true); err == nil {
		for _, ioc := range ioCounters {
			netIO = append(netIO, NetIOStat{
				Name:      ioc.Name,
				BytesRecv: ioc.BytesRecv,
				BytesSent: ioc.BytesSent,
			})
		}
	}

	return SysStat{
		Timestamp:      time.Now(),
		CpuUtilPerCore: cpuPcts,
		MemTotalMB:     int(vmStat.Total / toMB), // #nosec G115 -- MB-scale memory counter cannot overflow int on supported platforms
		MemUsedMB:      int(vmStat.Used / toMB),  // #nosec G115 -- MB-scale memory counter cannot overflow int on supported platforms
		MemFreeMB:      int(vmStat.Free / toMB),  // #nosec G115 -- MB-scale memory counter cannot overflow int on supported platforms
		NetIO:          netIO,
	}, nil
}
