package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/repolab/repolab/runner/internal/protocol"
	"github.com/repolab/repolab/runner/internal/supervisor"
)

const runnerVersion = "0.1.0"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dockerPath, err := exec.LookPath("docker")
	if err != nil { logger.Error("docker executable unavailable", "error", err); os.Exit(2) }
	sup := supervisor.New(dockerPath)
	if err := protocol.Write(os.Stdout, protocol.Handshake{Type: "handshake", ProtocolVersion: protocol.ProtocolVersion, RunnerVersion: runnerVersion, SupportedPlanVersions: []int{1}, Platform: runtime.GOOS + "/" + runtime.GOARCH, Capabilities: []string{"docker-check", "bounded-cancellation", "resource-reconciliation"}}); err != nil { logger.Error("write handshake", "error", err); os.Exit(1) }
	reader := bufio.NewReaderSize(os.Stdin, protocol.MaxFrameBytes+4)
	for {
		select { case <-ctx.Done(): _ = sup.Shutdown(context.Background()); return; default: }
		message, readErr := protocol.Read(reader)
		if errors.Is(readErr, os.ErrClosed) || errors.Is(readErr, context.Canceled) { _ = sup.Shutdown(context.Background()); return }
		if readErr != nil {
			if errors.Is(readErr, syscall.EPIPE) || errors.Is(readErr, context.Canceled) { _ = sup.Shutdown(context.Background()); return }
			logger.Error("protocol read failed", "error", readErr); _ = sup.Shutdown(context.Background()); return
		}
		command, ok := message.(protocol.Command)
		if !ok { logger.Error("unexpected protocol message"); return }
		if err := handle(ctx, sup, command); err != nil { logger.Error("command failed", "requestId", command.RequestID, "error", err); _ = writeEvent(command, "failed", map[string]interface{}{"message": err.Error()}, "runner_command_failed") }
	}
}

func handle(parent context.Context, sup *supervisor.Supervisor, command protocol.Command) error {
	if err := writeEvent(command, "accepted", map[string]interface{}{}, ""); err != nil { return err }
	switch command.Command {
	case "capabilities":
		return writeEvent(command, "completed", map[string]interface{}{"protocolVersion": protocol.ProtocolVersion, "planVersions": []int{1}}, "")
	case "prepare":
		ctx, cancel := context.WithTimeout(parent, 10*time.Second); defer cancel()
		if err := sup.CheckDocker(ctx); err != nil { return fmt.Errorf("prepare: %w", err) }
		return writeEvent(command, "completed", map[string]interface{}{"validated": true}, "")
	case "cancel":
		if command.RunID == "" { return errors.New("cancel requires runId") }
		sup.Cancel(command.RunID)
		return writeEvent(command, "completed", map[string]interface{}{"cancelRequested": true}, "")
	case "cleanup", "reconcile", "reset_faults", "collect", "apply_fault", "start", "shutdown":
		// The command surface is versioned before Docker recipes are expanded. These operations only
		// complete after their plan-specific implementation is present; they do not fabricate evidence.
		return errors.New("command is not enabled in this runner build")
	default:
		return errors.New("unknown command")
	}
}

func writeEvent(command protocol.Command, name string, payload map[string]interface{}, code string) error {
	return protocol.Write(os.Stdout, protocol.Event{Type: "event", Event: name, RequestID: command.RequestID, RunID: command.RunID, AttemptID: command.AttemptID, Sequence: "1", Payload: payload, ErrorCode: code})
}
