package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var ErrBusy = errors.New("runner already has an active run")

type Supervisor struct {
	mu         sync.Mutex
	dockerPath string
	active     map[string]context.CancelFunc
}

func New(dockerPath string) *Supervisor { return &Supervisor{dockerPath: dockerPath, active: make(map[string]context.CancelFunc)} }

func (s *Supervisor) CheckDocker(ctx context.Context) error {
	if s.dockerPath == "" { return errors.New("docker executable is not resolved") }
	command := exec.CommandContext(ctx, s.dockerPath, "version", "--format", "{{.Server.Version}}")
	output, err := command.Output()
	if err != nil { return fmt.Errorf("docker capability check: %w", err) }
	if strings.TrimSpace(string(output)) == "" { return errors.New("docker returned no server version") }
	return nil
}

func (s *Supervisor) Begin(ctx context.Context, runID string) (context.Context, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.active) > 0 { return nil, ErrBusy }
	runContext, cancel := context.WithCancel(ctx)
	s.active[runID] = cancel
	return runContext, nil
}

func (s *Supervisor) End(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel, ok := s.active[runID]; ok { cancel(); delete(s.active, runID) }
}

func (s *Supervisor) Cancel(runID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cancel, ok := s.active[runID]
	if ok { cancel() }
	return ok
}

func (s *Supervisor) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	for _, cancel := range s.active { cancel() }
	s.active = make(map[string]context.CancelFunc)
	s.mu.Unlock()
	select { case <-ctx.Done(): return ctx.Err(); case <-time.After(10 * time.Millisecond): return nil }
}
