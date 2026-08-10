package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const dataFileName = "manemark-data.json"
const readChunkSize = 500 * 1024

type request struct {
	Action      string `json:"action"`
	FolderPath  string `json:"folderPath"`
	InitialPath string `json:"initialPath"`
	FileName    string `json:"fileName"`
	Content     string `json:"content"`
}

type response map[string]any

func writeMessage(w *bufio.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) > 1024*1024 {
		return fmt.Errorf("response too large: %d bytes", len(payload))
	}

	var length [4]byte
	binary.LittleEndian.PutUint32(length[:], uint32(len(payload)))
	if _, err := w.Write(length[:]); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	return w.Flush()
}

func readMessage(r *bufio.Reader) ([]byte, error) {
	var length [4]byte
	if _, err := io.ReadFull(r, length[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(length[:])
	if n == 0 || n > 64*1024*1024 {
		return nil, fmt.Errorf("invalid incoming message size: %d", n)
	}
	payload := make([]byte, int(n))
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func cleanFolder(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("no folder path was supplied")
	}
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return "", errors.New("the storage path must be an absolute folder path")
	}
	return path, nil
}

func dataPath(folder string) string {
	return filepath.Join(folder, dataFileName)
}

func chooseFolder(initial string) (string, bool, error) {
	switch runtime.GOOS {
	case "windows":
		script := `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose Manemark storage folder'; if ($env:MANEMARK_INITIAL_PATH -and (Test-Path -LiteralPath $env:MANEMARK_INITIAL_PATH)) { $d.SelectedPath = $env:MANEMARK_INITIAL_PATH }; $r = $d.ShowDialog(); if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath }`
		cmd := exec.Command("powershell.exe", "-NoProfile", "-STA", "-Command", script)
		cmd.Env = append(os.Environ(), "MANEMARK_INITIAL_PATH="+initial)
		out, err := cmd.Output()
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) && len(ee.Stderr) > 0 {
				return "", false, fmt.Errorf("folder chooser failed: %s", strings.TrimSpace(string(ee.Stderr)))
			}
			return "", false, fmt.Errorf("folder chooser failed: %w", err)
		}
		selected := strings.TrimSpace(string(out))
		if selected == "" {
			return "", true, nil
		}
		return selected, false, nil

	case "darwin":
		cmd := exec.Command("osascript", "-e", `POSIX path of (choose folder with prompt "Choose Manemark storage folder")`)
		out, err := cmd.Output()
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				// AppleScript returns a non-zero exit when the user cancels.
				return "", true, nil
			}
			return "", false, err
		}
		selected := strings.TrimSpace(string(out))
		if selected == "" {
			return "", true, nil
		}
		return strings.TrimSuffix(selected, string(os.PathSeparator)), false, nil

	case "linux":
		if path, err := exec.LookPath("zenity"); err == nil {
			args := []string{"--file-selection", "--directory", "--title=Choose Manemark storage folder"}
			if initial != "" {
				args = append(args, "--filename="+strings.TrimRight(initial, "/")+"/")
			}
			out, err := exec.Command(path, args...).Output()
			if err != nil {
				return "", true, nil
			}
			return strings.TrimSpace(string(out)), false, nil
		}
		if path, err := exec.LookPath("kdialog"); err == nil {
			args := []string{"--getexistingdirectory", initial, "--title", "Choose Manemark storage folder"}
			out, err := exec.Command(path, args...).Output()
			if err != nil {
				return "", true, nil
			}
			return strings.TrimSpace(string(out)), false, nil
		}
		return "", false, errors.New("no native folder chooser is installed; type the absolute folder path in Manemark instead")
	default:
		return "", false, fmt.Errorf("folder chooser is not implemented for %s; type the absolute folder path instead", runtime.GOOS)
	}
}

func handleRead(w *bufio.Writer, folder string) error {
	folder, err := cleanFolder(folder)
	if err != nil {
		return writeMessage(w, response{"ok": false, "error": err.Error()})
	}

	content, err := os.ReadFile(dataPath(folder))
	if err != nil {
		if os.IsNotExist(err) {
			if err := writeMessage(w, response{"ok": true, "type": "readStart", "exists": false, "chunks": 0}); err != nil {
				return err
			}
			return writeMessage(w, response{"ok": true, "type": "readEnd"})
		}
		return writeMessage(w, response{"ok": false, "error": fmt.Sprintf("could not read storage file: %v", err)})
	}

	chunks := 0
	if len(content) > 0 {
		chunks = (len(content) + readChunkSize - 1) / readChunkSize
	}
	if err := writeMessage(w, response{"ok": true, "type": "readStart", "exists": true, "chunks": chunks, "bytes": len(content)}); err != nil {
		return err
	}

	for i, start := 0, 0; start < len(content); i, start = i+1, start+readChunkSize {
		end := start + readChunkSize
		if end > len(content) {
			end = len(content)
		}
		encoded := base64.StdEncoding.EncodeToString(content[start:end])
		if err := writeMessage(w, response{"ok": true, "type": "readChunk", "index": i, "data": encoded}); err != nil {
			return err
		}
	}
	return writeMessage(w, response{"ok": true, "type": "readEnd"})
}

func handleWrite(w *bufio.Writer, folder, content string) error {
	folder, err := cleanFolder(folder)
	if err != nil {
		return writeMessage(w, response{"ok": false, "error": err.Error()})
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return writeMessage(w, response{"ok": false, "error": fmt.Sprintf("could not create storage folder: %v", err)})
	}

	// Validate that Manemark is writing JSON before replacing the durable copy.
	var js any
	decoder := json.NewDecoder(bytes.NewBufferString(content))
	if err := decoder.Decode(&js); err != nil {
		return writeMessage(w, response{"ok": false, "error": "refusing to write invalid JSON data"})
	}

	target := dataPath(folder)
	temp := target + ".tmp"
	if err := os.WriteFile(temp, []byte(content), 0o600); err != nil {
		return writeMessage(w, response{"ok": false, "error": fmt.Sprintf("could not write temporary storage file: %v", err)})
	}

	// Windows does not reliably replace an existing destination with Rename,
	// so remove the old copy only after the complete temporary file exists.
	_ = os.Remove(target)
	if err := os.Rename(temp, target); err != nil {
		_ = os.Remove(temp)
		return writeMessage(w, response{"ok": false, "error": fmt.Sprintf("could not replace storage file: %v", err)})
	}

	return writeMessage(w, response{"ok": true, "type": "writeDone", "path": target, "bytes": len(content)})
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)

	for {
		payload, err := readMessage(in)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return
			}
			fmt.Fprintln(os.Stderr, "Manemark native host read error:", err)
			return
		}

		var req request
		if err := json.Unmarshal(payload, &req); err != nil {
			_ = writeMessage(out, response{"ok": false, "error": "invalid request JSON"})
			continue
		}

		switch req.Action {
		case "ping":
			_ = writeMessage(out, response{"ok": true, "type": "pong", "platform": runtime.GOOS})

		case "chooseFolder":
			selected, canceled, err := chooseFolder(req.InitialPath)
			if err != nil {
				_ = writeMessage(out, response{"ok": false, "error": err.Error()})
				continue
			}
			_ = writeMessage(out, response{"ok": true, "type": "folderChosen", "path": selected, "canceled": canceled})

		case "read":
			if err := handleRead(out, req.FolderPath); err != nil {
				fmt.Fprintln(os.Stderr, "Manemark native host write response error:", err)
				return
			}

		case "write":
			if err := handleWrite(out, req.FolderPath, req.Content); err != nil {
				fmt.Fprintln(os.Stderr, "Manemark native host write response error:", err)
				return
			}

		default:
			_ = writeMessage(out, response{"ok": false, "error": "unknown action"})
		}
	}
}
