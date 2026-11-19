import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export type ToastKind = 'info' | 'ok' | 'error'
export interface Toast {
  id: number
  text: string
  kind: ToastKind
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++idRef.current
    setToasts((list) => [...list.slice(-3), { id, text, kind }])
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3800)
  }, [])
  return { toasts, push }
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="spd-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`spd-toast ${toast.kind === 'error' ? 'error' : toast.kind === 'ok' ? 'ok' : ''}`}>
          {toast.text}
        </div>
      ))}
    </div>
  )
}

const ICONS: Record<string, string> = {
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M3 3l18 18M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.2 6.2C3.6 7.9 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4.2-.9',
  lock: 'M7 10V8a5 5 0 0 1 10 0v2M5 10h14v11H5z',
  unlock: 'M7 10V8a5 5 0 0 1 9.6-2M5 10h14v11H5z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M5 12l7 7 7-7',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  upload: 'M12 21V9M7 13l5-5 5 5M4 4h16',
  folder: 'M3 6h6l2 3h10v11H3z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4v.01M9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8',
  expand: 'M4 9V4h5M20 15v5h-5M9 4H4v5M15 20h5v-5',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6',
  play: 'M8 5l11 7-11 7z',
  check: 'M4 12.5l5 5L20 6.5',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  layers: 'M12 3l9 5-9 5-9-5 9-5Zm-9 9l9 5 9-5M3 16l9 5 9-5',
  scissors: 'M6 3l12 12M18 3L6 15M8 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm14 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  wand: 'M4 20L16 8M14 6l1-3 1 3 3 1-3 1-1 3-1-3-3-1 3-1ZM18 14l.8-2 .8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z',
  crop: 'M6 2v16h16M2 6h16v16',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 3v3M12 18v3M3 12h3M18 12h3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  save: 'M4 4h13l3 3v13H4zM8 4v6h8V4M8 20v-6h8v6',
  flip: 'M12 3v18M8 7L3 12l5 5M16 7l5 5-5 5',
  sparkle: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3Z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
}

export function Icon({ name, size = 16, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  const path = ICONS[name] ?? ICONS.help
  const stroke = name === 'eye' || name === 'play' || name === 'check' || name === 'sparkle' || name === 'wand'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={stroke ? 'currentColor' : 'none'}
      stroke={stroke ? 'none' : 'currentColor'}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="spd-logo">
      <defs>
        <linearGradient id="spd-logo-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#66c0f4" />
          <stop offset="1" stopColor="#2f74a8" />
        </linearGradient>
        <linearGradient id="spd-logo-b" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a4d007" />
          <stop offset="1" stopColor="#6e9211" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#16212c" stroke="#2c4357" />
      <rect x="5" y="7" width="22" height="18" rx="3" fill="url(#spd-logo-a)" opacity="0.9" />
      <rect x="10" y="12" width="12" height="8" rx="2" fill="#0d151d" opacity="0.92" />
      <circle cx="22" cy="10" r="2.2" fill="url(#spd-logo-b)" />
      <path d="M7 25c2.6-3.4 5.4-5 8.6-5 3.1 0 5.9 1.6 8.4 5" stroke="#0d151d" strokeWidth="2" fill="none" opacity="0.35" />
    </svg>
  )
}

export function NumField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return (
    <div className="spd-field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(clamp(Number(event.target.value)))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Math.round(value * 100) / 100}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(clamp(next))
        }}
        title={suffix}
      />
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className="spd-check" style={{ alignItems: hint ? 'flex-start' : 'center' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="spd-hint" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
    </label>
  )
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  size = 'normal',
  stage,
}: {
  title: ReactNode
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  size?: 'normal' | 'wide' | 'narrow'
  stage?: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="spd-modal-back" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`spd-modal ${size === 'wide' ? 'wide' : size === 'narrow' ? 'narrow' : ''}`}>
        <div className="spd-modal-head">
          <div className="spd-title" style={{ fontSize: 13 }}>
            {title}
          </div>
          <button className="icon ghost" onClick={onClose} title="Закрыть">
            <Icon name="close" />
          </button>
        </div>
        {stage ? <div className="spd-modal-stage">{stage}</div> : null}
        <div className="spd-modal-body">{children}</div>
        {footer ? <div className="spd-modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Divider() {
  return <div className="spd-divider" />
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="spd-seg">
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? 'active' : ''}
          title={option.title}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'только что'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} мин назад`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} ч назад`
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
