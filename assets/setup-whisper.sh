#!/bin/bash
# Setup whisper-cpp and ffmpeg for Design Explorer voice critiques
set -e

echo "=== Design Explorer: Voice Setup ==="

# Check/install ffmpeg
if command -v ffmpeg &>/dev/null; then
  echo "✓ ffmpeg already installed"
else
  echo "Installing ffmpeg..."
  brew install ffmpeg
fi

# Check/install whisper-cpp
if command -v whisper-cpp &>/dev/null; then
  echo "✓ whisper-cpp already installed"
else
  echo "Installing whisper-cpp..."
  brew install whisper-cpp
fi

# Download model if needed
MODEL_DIR="$HOME/.cache/whisper-cpp"
MODEL_FILE="$MODEL_DIR/ggml-small.en.bin"

if [ -f "$MODEL_FILE" ]; then
  echo "✓ Model already downloaded: $MODEL_FILE"
else
  echo "Downloading ggml-small.en model..."
  mkdir -p "$MODEL_DIR"

  # whisper-cpp ships a download script, but we can also grab directly
  DOWNLOAD_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
  curl -L -o "$MODEL_FILE" "$DOWNLOAD_URL"
  echo "✓ Model downloaded to $MODEL_FILE"
fi

echo ""
echo "=== Setup complete ==="
echo "whisper-cpp: $(which whisper-cpp)"
echo "ffmpeg: $(which ffmpeg)"
echo "Model: $MODEL_FILE"
