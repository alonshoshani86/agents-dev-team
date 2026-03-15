#!/bin/bash
set -e

echo "=== DevTeam Agent Platform ==="
echo ""

# Install dependencies if needed
if [ ! -d "backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  (cd backend && npm install)
fi

if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd frontend && npm install)
fi

# Start backend
echo "Starting backend on http://localhost:8001 ..."
(cd backend && npm run dev) &
BACKEND_PID=$!

# Start frontend
echo "Starting frontend on http://localhost:5173 ..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo ""
echo "Open http://localhost:5173 in your browser"
echo "Press Ctrl+C to stop both services"
echo ""

# Trap Ctrl+C to kill both
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
