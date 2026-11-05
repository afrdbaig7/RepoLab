// Code generated from packages/contracts/protocol.schema.json; DO NOT EDIT.
package protocol

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	ProtocolVersion = "1"
	MaxFrameBytes   = 1024 * 1024
)

var ErrFrameTooLarge = errors.New("runner protocol frame exceeds maximum size")

type Handshake struct {
	Type                 string   `json:"type"`
	ProtocolVersion      string   `json:"protocolVersion"`
	RunnerVersion        string   `json:"runnerVersion"`
	SupportedPlanVersions []int   `json:"supportedPlanVersions"`
	Platform             string   `json:"platform"`
	Capabilities         []string `json:"capabilities"`
}

type Command struct {
	Type            string                 `json:"type"`
	Command         string                 `json:"command"`
	RequestID       string                 `json:"requestId"`
	RunID           string                 `json:"runId,omitempty"`
	AttemptID       string                 `json:"attemptId,omitempty"`
	PlanFingerprint string                 `json:"planFingerprint,omitempty"`
	Payload         map[string]interface{} `json:"payload,omitempty"`
}

type Event struct {
	Type      string                 `json:"type"`
	Event     string                 `json:"event"`
	RequestID string                 `json:"requestId"`
	RunID     string                 `json:"runId,omitempty"`
	AttemptID string                 `json:"attemptId,omitempty"`
	Sequence  string                 `json:"sequence"`
	Payload   map[string]interface{} `json:"payload,omitempty"`
	ErrorCode string                 `json:"errorCode,omitempty"`
}

func Write(w io.Writer, value any) error {
	body, err := json.Marshal(value)
	if err != nil { return fmt.Errorf("encode protocol message: %w", err) }
	if len(body) > MaxFrameBytes { return ErrFrameTooLarge }
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(body)))
	if _, err := w.Write(prefix[:]); err != nil { return fmt.Errorf("write frame prefix: %w", err) }
	if _, err := w.Write(body); err != nil { return fmt.Errorf("write frame body: %w", err) }
	return nil
}

func Read(r *bufio.Reader) (any, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil { return nil, err }
	size := binary.BigEndian.Uint32(prefix[:])
	if size > MaxFrameBytes { return nil, ErrFrameTooLarge }
	body := make([]byte, size)
	if _, err := io.ReadFull(r, body); err != nil { return nil, fmt.Errorf("read frame: %w", err) }
	var envelope struct{ Type string `json:"type"` }
	if err := json.Unmarshal(body, &envelope); err != nil { return nil, fmt.Errorf("invalid protocol JSON: %w", err) }
	switch envelope.Type {
	case "command":
		var value Command
		if err := strictDecode(body, &value); err != nil { return nil, err }
		if value.RequestID == "" || value.Command == "" { return nil, errors.New("command requires requestId and command") }
		return value, nil
	default:
		return nil, fmt.Errorf("unknown protocol message type %q", envelope.Type)
	}
}

func strictDecode(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil { return fmt.Errorf("invalid protocol JSON: %w", err) }
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF { return errors.New("trailing protocol data") }
	return nil
}
