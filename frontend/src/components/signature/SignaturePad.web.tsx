import { useEffect, useRef } from 'react';

import { useMode } from '@/theme/mode';

import { CANVAS_HEIGHT, CANVAS_WIDTH } from './render';

type Props = {
  /** PNG of the drawing as a data URL, or null when the box is empty / was cleared. */
  onChange: (png: string | null) => void;
  clearSignal: number;   // changes when the parent asks to clear the box
  /** The colour of the strokes IN THE IMAGE (the document is printed on white): a plain colour, never a theme variable. */
  ink?: string;
  border?: string;
  /** Behind the box, on the screen only (the image itself stays transparent). */
  surface?: string;
  label?: string;
};

/**
 * Drawn signature: the mouse, the finger or a pen, on a real <canvas> — pointer events cover all three.
 * Transparent outside the strokes, so it can be printed over a signature line. Web only (Expo picks this
 * file on the web; SignaturePad.tsx is the native placeholder).
 */
export function SignaturePad({ onChange, clearSignal, ink = '#14232F', border = '#D1D5DB', surface = '#FFFFFF', label }: Props) {
  const dark = useMode() === 'dark';
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    inked.current = false;
    onChange(null);
  }, [clearSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    // The box has a fixed resolution and is shown at any width: scale the pointer to it.
    return { x: ((e.clientX - rect.left) / rect.width) * CANVAS_WIDTH, y: ((e.clientY - rect.top) / rect.height) * CANVAS_HEIGHT };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = point(e);
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    inked.current = true;
  }

  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) onChange(e.currentTarget.toDataURL('image/png'));
  }

  // Dark mode (31/10/2026): the strokes are always dark in the image (it goes on a white document), so on the
  // screen only the canvas is shown inverted — light strokes over the dark box. The PNG is not affected.
  return (
    <div style={{ width: '100%', maxWidth: CANVAS_WIDTH, background: surface, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
      <canvas ref={canvas} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} role="img"
              aria-label={label ?? 'Quadro de assinatura: assine com o mouse, o dedo ou a caneta'}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
              style={{ display: 'block', width: '100%', aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`, touchAction: 'none',
                       cursor: 'crosshair', filter: dark ? 'invert(1) hue-rotate(180deg)' : undefined }} />
    </div>
  );
}
