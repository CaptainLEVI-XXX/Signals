'use client';

import { useEffect, useRef, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';

// FrequencyBarsCanvas - Canvas-based frequency bar visualiser, full-width, smooth 60 fps.

interface FrequencyBarsCanvasProps {
  variant?: 'hero' | 'ambient' | 'intense';
  className?: string;
}

interface BarState {
  currentHeight: number;
  targetHeight: number;
  phase: number;
  speed: number;
  baseHeight: number;
}

export function FrequencyBarsCanvas({ variant = 'hero', className = '' }: FrequencyBarsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const barsRef = useRef<BarState[]>([]);

  const config = useMemo(() => {
    switch (variant) {
      case 'intense':
        return {
          barCount: 50,
          maxHeight: 300,
          opacity: 0.35,
          glowStrength: 0.6,
          speed: 1.2,
        };
      case 'ambient':
        return {
          barCount: 40,
          maxHeight: 100,
          opacity: 0.2,
          glowStrength: 0.3,
          speed: 0.7,
        };
      default: // hero
        return {
          barCount: 50,
          maxHeight: 300,
          opacity: 0.28,
          glowStrength: 0.45,
          speed: 0.9,
        };
    }
  }, [variant]);

  const initBars = useCallback(
    (count: number): BarState[] =>
      Array.from({ length: count }, () => {
        const base = 0.15 + Math.random() * 0.35;
        return {
          currentHeight: base,
          targetHeight: base,
          phase: Math.random() * Math.PI * 2,
          speed: 0.3 + Math.random() * 0.5,
          baseHeight: base,
        };
      }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    barsRef.current = initBars(config.barCount);
    let time = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    const animate = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      const bars = barsRef.current;
      const barCount = bars.length;
      const gap = 3;
      const barWidth = Math.max(2, (w - gap * (barCount - 1)) / barCount);

      for (let i = 0; i < barCount; i++) {
        const bar = bars[i];

        bar.targetHeight =
          bar.baseHeight +
          Math.sin(time * bar.speed * config.speed + bar.phase) * 0.25 +
          Math.sin(time * bar.speed * config.speed * 0.6 + bar.phase * 1.7) * 0.1;

        bar.currentHeight += (bar.targetHeight - bar.currentHeight) * 0.08;

        const barH = Math.max(4, bar.currentHeight * h);
        const x = i * (barWidth + gap);
        const y = h - barH;

        const grad = ctx.createLinearGradient(x, h, x, y);
        grad.addColorStop(0, `rgba(139, 92, 246, ${config.opacity})`);
        grad.addColorStop(0.4, `rgba(168, 85, 247, ${config.opacity * 0.9})`);
        grad.addColorStop(0.8, `rgba(109, 40, 217, ${config.opacity * 0.7})`);
        grad.addColorStop(1, `rgba(109, 40, 217, ${config.opacity * 0.4})`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        const radius = Math.min(barWidth / 2, 3);
        ctx.moveTo(x, h);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.lineTo(x + barWidth - radius, y);
        ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
        ctx.lineTo(x + barWidth, h);
        ctx.closePath();
        ctx.fill();

        if (config.glowStrength > 0) {
          const glowGrad = ctx.createRadialGradient(
            x + barWidth / 2, y, 0,
            x + barWidth / 2, y, barWidth * 2,
          );
          glowGrad.addColorStop(0, `rgba(192, 132, 252, ${config.glowStrength * 0.35 * bar.currentHeight})`);
          glowGrad.addColorStop(1, 'rgba(192, 132, 252, 0)');

          ctx.fillStyle = glowGrad;
          ctx.fillRect(x - barWidth, y - barWidth * 2, barWidth * 3, barWidth * 4);
        }
      }

      time += 0.016;
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
    };
  }, [config, initBars]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full pointer-events-none ${className}`}
    />
  );
}

// SignalWaveBackground

interface SignalWaveBackgroundProps {
  variant?: 'hero' | 'ambient' | 'intense';
  className?: string;
}

export function SignalWaveBackground({
  variant = 'hero',
  className = '',
}: SignalWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  const config = useMemo(() => {
    switch (variant) {
      case 'intense':
        return {
          waveCount: 5,
          baseAmplitude: 60,
          baseFrequency: 0.015,
          speed: 0.03,
          opacity: 0.4,
          colors: ['#8B5CF6', '#A855F7', '#C084FC', '#7C3AED', '#6D28D9'],
        };
      case 'ambient':
        return {
          waveCount: 3,
          baseAmplitude: 30,
          baseFrequency: 0.008,
          speed: 0.015,
          opacity: 0.15,
          colors: ['#8B5CF6', '#A855F7', '#7C3AED'],
        };
      default:
        return {
          waveCount: 4,
          baseAmplitude: 45,
          baseFrequency: 0.012,
          speed: 0.02,
          opacity: 0.25,
          colors: ['#8B5CF6', '#A855F7', '#C084FC', '#7C3AED'],
        };
    }
  }, [variant]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    const drawWave = (
      yOffset: number,
      amplitude: number,
      frequency: number,
      phase: number,
      color: string,
      opacity: number,
    ) => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      ctx.beginPath();
      ctx.moveTo(0, yOffset);

      for (let x = 0; x <= width; x += 2) {
        const y =
          yOffset +
          Math.sin(x * frequency + phase) * amplitude +
          Math.sin(x * frequency * 2.3 + phase * 1.5) * (amplitude * 0.3) +
          Math.sin(x * frequency * 0.5 + phase * 0.7) * (amplitude * 0.5);

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();

      const gradient = ctx.createLinearGradient(0, yOffset - amplitude, 0, height);
      gradient.addColorStop(0, color + Math.round(opacity * 255).toString(16).padStart(2, '0'));
      gradient.addColorStop(0.5, color + Math.round(opacity * 0.3 * 255).toString(16).padStart(2, '0'));
      gradient.addColorStop(1, color + '00');

      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, yOffset);
      for (let x = 0; x <= width; x += 2) {
        const y =
          yOffset +
          Math.sin(x * frequency + phase) * amplitude +
          Math.sin(x * frequency * 2.3 + phase * 1.5) * (amplitude * 0.3) +
          Math.sin(x * frequency * 0.5 + phase * 0.7) * (amplitude * 0.5);
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color + Math.round(Math.min(1, opacity * 1.5) * 255).toString(16).padStart(2, '0');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    const animate = () => {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      config.colors.forEach((color, i) => {
        const yOffset = rect.height * (0.3 + i * 0.15);
        const amplitude = config.baseAmplitude * (1 - i * 0.15);
        const frequency = config.baseFrequency * (1 + i * 0.2);
        const phase = time + i * 0.8;
        const opacity = config.opacity * (1 - i * 0.1);

        drawWave(yOffset, amplitude, frequency, phase, color, opacity);
      });

      time += config.speed;
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
    };
  }, [config]);

  return (
    <div className={`absolute inset-0 overflow-hidden ${className}`}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ opacity: 0.8 }}
      />
      <div
        className="absolute inset-0 opacity-[0.03] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />
    </div>
  );
}

// OscilloscopeDisplay

export function OscilloscopeDisplay({
  intensity = 0.5,
  color = '#8B5CF6',
  className = '',
}: {
  intensity?: number;
  color?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    const animate = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const centerY = height / 2;

      ctx.fillStyle = 'rgba(12, 10, 18, 0.15)';
      ctx.fillRect(0, 0, width, height);

      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.strokeStyle = color + '20';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      const amplitude = height * 0.35 * intensity;

      for (let x = 0; x <= width; x += 1) {
        const normalizedX = x / width;
        const y =
          centerY +
          Math.sin(normalizedX * 8 * Math.PI + time) * amplitude * 0.6 +
          Math.sin(normalizedX * 12 * Math.PI + time * 1.3) * amplitude * 0.25 +
          Math.sin(normalizedX * 3 * Math.PI + time * 0.7) * amplitude * 0.15;

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = color + 'CC';
      ctx.lineWidth = 1;
      ctx.stroke();

      time += 0.05;
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
    };
  }, [intensity, color]);

  return <canvas ref={canvasRef} className={`w-full h-full ${className}`} />;
}

// FrequencyBars (DOM-based, kept for backward compat)

export function FrequencyBars({
  barCount = 32,
  color = '#8B5CF6',
  className = '',
}: {
  barCount?: number;
  color?: string;
  className?: string;
}) {
  return (
    <div className={`flex items-end justify-center gap-[2px] h-full ${className}`}>
      {Array.from({ length: barCount }).map((_, i) => {
        const delay = i * 0.05;
        const baseHeight = 20 + Math.sin(i * 0.5) * 30;

        return (
          <motion.div
            key={i}
            className="w-1 rounded-t-sm"
            style={{ backgroundColor: color }}
            initial={{ height: `${baseHeight}%` }}
            animate={{
              height: [`${baseHeight}%`, `${baseHeight + 40}%`, `${baseHeight}%`],
              opacity: [0.4, 0.8, 0.4],
            }}
            transition={{
              duration: 1 + Math.random() * 0.5,
              repeat: Infinity,
              delay,
              ease: 'easeInOut',
            }}
          />
        );
      })}
    </div>
  );
}

// SignalsIcon (utility SVG)

export function SignalsIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 12h2" />
      <path d="M6 8v8" />
      <path d="M10 4v16" />
      <path d="M14 6v12" />
      <path d="M18 9v6" />
      <path d="M22 12h-2" />
    </svg>
  );
}
