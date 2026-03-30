/**
 * DrawingCanvas — Phase 1 Skeleton
 * ==================================
 * Renders an HTML5 canvas and captures mouse/touch drawing input.
 * Strokes are logged to console (Phase 1) and will be sent via
 * WebSocket in Phase 2.
 *
 * Stroke schema (matches replica StrokePayload):
 *   {
 *     stroke_id: string,      // uuid-like unique id
 *     points:    [{x, y}],    // normalized 0–1 coordinates
 *     color:     string,      // hex color
 *     width:     number,      // brush width in px
 *   }
 */

import { useRef, useEffect, useCallback, useState } from "react";

const COLORS = ["#3d8bff", "#6bd4a8", "#f5a623", "#ff5a5a", "#c084fc", "#fb7185", "#e8eaf0"];

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function DrawingCanvas({ onStrokeComplete, externalStrokes = [] }) {
  const canvasRef = useRef(null);
  const isDrawing = useRef(false);
  const currentPoints = useRef([]);
  const [activeColor, setActiveColor] = useState(COLORS[0]);
  const [brushSize, setBrushSize] = useState(3);

  // ── Canvas setup ────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const resize = () => {
      // Preserve drawn content on resize via a temp image
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      ctx.putImageData(img, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // ── Render external strokes ────────────────────────────────────────────────
  // Three cases:
  //   1. Live stroke appended   → draw only the new one
  //   2. Live clear appended    → clear the canvas
  //   3. Full replay on connect → clear and redraw all (skipping clear entries)

  const prevStrokesLen = useRef(0);

  useEffect(() => {
    if (!externalStrokes.length) return;
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext("2d");

    const isAppend = externalStrokes.length === prevStrokesLen.current + 1;
    prevStrokesLen.current = externalStrokes.length;

    if (isAppend) {
      const latest = externalStrokes[externalStrokes.length - 1];
      if (latest.type === "clear") {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        drawStroke(ctx, latest, canvas.width, canvas.height);
      }
    } else {
      // Full replay — clear then repaint, honouring any clear events in sequence
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const stroke of externalStrokes) {
        if (stroke.type === "clear") {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
          drawStroke(ctx, stroke, canvas.width, canvas.height);
        }
      }
    }
  }, [externalStrokes]);

  // ── Drawing helpers ──────────────────────────────────────────────────────────

  function drawStroke(ctx, stroke, w, h) {
    if (!stroke.points?.length) return;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const pts = stroke.points;
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * w, pts[i].y * h);
    }
    ctx.stroke();
  }

  function getPos(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return {
      x: (src.clientX - rect.left) / rect.width,
      y: (src.clientY - rect.top) / rect.height,
    };
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  const startDraw = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      isDrawing.current = true;
      const pos = getPos(e, canvas);
      currentPoints.current = [pos];

      const ctx = canvas.getContext("2d");
      ctx.beginPath();
      ctx.moveTo(pos.x * canvas.width, pos.y * canvas.height);
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = brushSize;
    },
    [activeColor, brushSize]
  );

  const draw = useCallback((e) => {
    if (!isDrawing.current) return;
    e.preventDefault();

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const pos = getPos(e, canvas);
    currentPoints.current.push(pos);

    ctx.lineTo(pos.x * canvas.width, pos.y * canvas.height);
    ctx.stroke();
  }, []);

  const endDraw = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;

    if (currentPoints.current.length < 2) {
      currentPoints.current = [];
      return;
    }

    const stroke = {
      stroke_id: generateId(),
      points:    currentPoints.current,
      color:     activeColor,
      width:     brushSize,
    };

    currentPoints.current = [];
    onStrokeComplete?.(stroke);
  }, [activeColor, brushSize, onStrokeComplete]);

  const clearCanvas = useCallback(() => {
    // Clear locally immediately for snappy UX
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Send clear through RAFT pipeline so all other tabs clear too
    onStrokeComplete?.({
      stroke_id: generateId(),
      type:      "clear",
      points:    [],
      color:     "",
      width:     0,
    });
  }, [onStrokeComplete]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={styles.wrapper}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <span style={styles.toolLabel}>COLOR</span>
        <div style={styles.swatches}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setActiveColor(c)}
              style={{
                ...styles.swatch,
                background: c,
                boxShadow: activeColor === c ? `0 0 0 2px #0d0e11, 0 0 0 4px ${c}` : "none",
              }}
              title={c}
            />
          ))}
        </div>

        <span style={styles.toolLabel}>SIZE</span>
        <input
          type="range"
          min="1"
          max="20"
          value={brushSize}
          onChange={(e) => setBrushSize(Number(e.target.value))}
          style={styles.slider}
        />
        <span style={{ ...styles.toolLabel, minWidth: 24 }}>{brushSize}px</span>

        <button onClick={clearCanvas} style={styles.clearBtn}>CLEAR</button>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        style={styles.canvas}
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={endDraw}
      />
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    overflow: "hidden",
    position: "relative",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    background: "var(--bg-card)",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
    flexWrap: "wrap",
  },
  toolLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "var(--text-secondary)",
    letterSpacing: "0.08em",
  },
  swatches: {
    display: "flex",
    gap: 6,
  },
  swatch: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    border: "none",
    cursor: "pointer",
    transition: "box-shadow 0.15s",
  },
  slider: {
    width: 80,
    accentColor: "var(--accent)",
  },
  clearBtn: {
    marginLeft: "auto",
    padding: "4px 12px",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.06em",
    cursor: "pointer",
    transition: "border-color 0.15s, color 0.15s",
  },
  canvas: {
    flex: 1,
    width: "100%",
    cursor: "crosshair",
    display: "block",
    background: "#f8f9fb",
  },
};
