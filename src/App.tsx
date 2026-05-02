import { useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

declare function gtag(command: string, eventName: string, params?: Record<string, unknown>): void

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

const LOCATION_INTERVAL_MS = 10_000
const MOVE_THRESHOLD_M     = 10

// ── Speed constants (nominal — feed both speed-cap labels and drawer time calc) ─
const WALK_SPEED_MS = 5000 / 3600   // 5 km/h → ~1.39 m/s
const BIKE_SPEED_MS = 18000 / 3600  // 18 km/h → 5 m/s

// ── Theme tokens ─────────────────────────────────────────────────────────────

function tok(dark: boolean) {
  return dark ? {
    bodyBg:         '#0e0d0a',
    bg:             'rgba(18,17,14,0.97)',
    bgBlur:         'rgba(18,17,14,0.92)',
    text:           'rgba(255,255,255,0.7)',
    textMuted:      'rgba(255,255,255,0.3)',
    border:         'rgba(255,255,255,0.1)',
    borderFaint:    'rgba(255,255,255,0.07)',
    borderSep:      'rgba(255,255,255,0.06)',
    handle:         'rgba(255,255,255,0.14)',
    btnBg:          'rgba(255,255,255,0.03)',
    btnBorder:      'rgba(255,255,255,0.07)',
    btnText:        'rgba(255,255,255,0.4)',
    gearColor:      'rgba(255,255,255,0.3)',
    subduedFg:      'rgba(255,255,255,0.35)',
    bannerBg:       'rgba(220,38,38,0.15)',
    bannerBorder:   'rgba(220,38,38,0.3)',
    bannerText:     '#fca5a5',
    codeText:       'rgba(255,255,255,0.6)',
    codeBg:         'rgba(255,255,255,0.07)',
    codeBorder:     'rgba(255,255,255,0.1)',
    mapStyle:       'mapbox://styles/mapbox/dark-v11',
    parchmentSheet: 'rgba(18,17,14,0.97)',
    inkSoft:        'rgba(255,255,255,0.38)',
    borderSoft:     'rgba(255,255,255,0.1)',
    handleBar:      'rgba(255,255,255,0.14)',
    placeChipBg:    'rgba(26,25,22,0.92)',
    markFill:       '#1a1916',
    dialTick:       'rgba(255,255,255,0.2)',
    cardBg:         'rgba(255,255,255,0.06)',
  } : {
    bodyBg:         '#F2EBDD',
    bg:             'rgba(245,243,238,0.97)',
    bgBlur:         'rgba(245,243,238,0.92)',
    text:           'rgba(42,38,32,0.82)',
    textMuted:      'rgba(42,38,32,0.45)',
    border:         'rgba(0,0,0,0.1)',
    borderFaint:    'rgba(0,0,0,0.07)',
    borderSep:      'rgba(0,0,0,0.06)',
    handle:         'rgba(0,0,0,0.12)',
    btnBg:          'rgba(0,0,0,0.03)',
    btnBorder:      'rgba(0,0,0,0.08)',
    btnText:        'rgba(0,0,0,0.45)',
    gearColor:      'rgba(0,0,0,0.3)',
    subduedFg:      'rgba(0,0,0,0.38)',
    bannerBg:       'rgba(220,38,38,0.08)',
    bannerBorder:   'rgba(220,38,38,0.25)',
    bannerText:     '#dc2626',
    codeText:       'rgba(0,0,0,0.5)',
    codeBg:         'rgba(0,0,0,0.05)',
    codeBorder:     'rgba(0,0,0,0.1)',
    mapStyle:       'mapbox://styles/mapbox/light-v11',
    parchmentSheet: 'rgba(251,246,233,0.96)',
    inkSoft:        '#7A7468',
    borderSoft:     '#E8DFC9',
    handleBar:      '#D9CFB6',
    placeChipBg:    'rgba(255,255,255,0.85)',
    markFill:       '#F2EBDD',
    dialTick:       '#C9BE9F',
    cardBg:         '#ffffff',
  }
}

type Tok = ReturnType<typeof tok>

// ── Pure helpers ─────────────────────────────────────────────────────────────

function metersApart(a: [number, number], b: [number, number]): number {
  const R      = 6_371_000
  const dLat   = ((b[1] - a[1]) * Math.PI) / 180
  const dLng   = ((b[0] - a[0]) * Math.PI) / 180
  const cosLat = Math.cos((a[1] * Math.PI) / 180)
  return Math.sqrt(dLat * dLat + (dLng * cosLat) * (dLng * cosLat)) * R
}

function bearingTo(from: [number, number], to: [number, number]): number {
  const dLng = ((to[0] - from[0]) * Math.PI) / 180
  const lat1 = (from[1] * Math.PI) / 180
  const lat2 = (to[1]   * Math.PI) / 180
  const x    = Math.sin(dLng) * Math.cos(lat2)
  const y    = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const ARROWS    = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']

function toCardinal(deg: number): { cardinal: string; arrow: string } {
  const i = Math.round(deg / 45) % 8
  return { cardinal: CARDINALS[i], arrow: ARROWS[i] }
}

function formatDistance(metres: number, units: 'metric' | 'imperial'): string {
  if (units === 'imperial') {
    const mi = metres / 1609.34
    return mi < 0.1 ? `${Math.round(metres * 3.28084)}ft` : `${mi.toFixed(1)}mi`
  }
  return metres < 1000 ? `${Math.round(metres)}m` : `${(metres / 1000).toFixed(1)}km`
}

function formatLatLon([lng, lat]: [number, number]): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`
}

function formatSpeedCap(speedMs: number, units: 'metric' | 'imperial'): string {
  if (units === 'imperial') return `≤${Math.round(speedMs * 3600 / 1609.34)} mph`
  return `≤${Math.round(speedMs * 3.6)} km/h`
}

function walkTimeMin(distanceM: number, mode: string): number {
  const speed = mode === 'cycling' ? BIKE_SPEED_MS : WALK_SPEED_MS
  return Math.max(1, Math.round(distanceM / speed / 60))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isochroneRadius(center: [number, number], isoData: any): number {
  const ring: [number, number][] = isoData?.features?.[0]?.geometry?.coordinates?.[0] ?? []
  let max = 0
  for (const v of ring) max = Math.max(max, metersApart(center, v as [number, number]))
  return Math.min(Math.ceil(max * 1.1), 50_000)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isoSamplePoints(center: [number, number], isoData: any, nBoundary: number): [number, number][] {
  const ring: [number, number][] = isoData?.features?.[0]?.geometry?.coordinates?.[0] ?? []
  const points: [number, number][] = [center]
  if (ring.length === 0 || nBoundary === 0) return points
  const step = Math.floor(ring.length / nBoundary)
  for (let i = 0; i < nBoundary; i++) {
    const v = ring[(i * step) % ring.length] as [number, number]
    if (v) points.push(v)
  }
  return points
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pointInPolygon(point: [number, number], rings: [number, number][][]): boolean {
  const [px, py] = point
  let inside = false
  const ring = rings[0]
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pointInFeature(point: [number, number], geom: any): boolean {
  if (!geom) return false
  if (geom.type === 'Polygon') return pointInPolygon(point, geom.coordinates)
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.some((poly: [number, number][][]) => pointInPolygon(point, poly))
  }
  return false
}

// ── Share obfuscation ─────────────────────────────────────────────────────────

const OBF_KEY = 'emanant-share-v1'

function obfuscateCoords(lat: number, lng: number): string {
  const payload = `${lat.toFixed(5)},${lng.toFixed(5)}`
  const key = Array.from(OBF_KEY).map(c => c.charCodeAt(0))
  const bytes = Array.from(payload).map((ch, i) => ch.charCodeAt(0) ^ key[i % key.length])
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function deobfuscateCoords(token: string): [number, number] | null {
  try {
    const pad = (4 - (token.length % 4)) % 4
    const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
    const key = Array.from(OBF_KEY).map(c => c.charCodeAt(0))
    const decoded = Array.from(atob(padded)).map((ch, i) => ch.charCodeAt(0) ^ key[i % key.length])
    const [latStr, lngStr] = String.fromCharCode(...decoded).split(',')
    const lat = parseFloat(latStr), lng = parseFloat(lngStr)
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return [lng, lat]
  } catch { return null }
}

// ── Map layer setup ───────────────────────────────────────────────────────────

function addMapLayers(map: mapboxgl.Map): void {
  if (!map.getSource('terrain-dem')) {
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14,
    })
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1 })
    map.addLayer({
      id: 'hillshade',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: { 'hillshade-exaggeration': 0.3 },
    })
  }
  if (!map.getLayer('parks-fill')) {
    map.addLayer({
      id: 'parks-fill',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'park', 'playground', 'pitch', 'garden', 'national_park'],
      paint: { 'fill-color': '#2D7A6C', 'fill-opacity': 0.12 },
    })
    map.addLayer({
      id: 'parks-outline',
      type: 'line',
      source: 'composite',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'park', 'playground', 'pitch', 'garden', 'national_park'],
      paint: { 'line-color': '#2D7A6C', 'line-width': 1, 'line-opacity': 0.35 },
    })
    map.addLayer({
      id: 'public-spaces-fill',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse_overlay',
      filter: ['in', 'class', 'pedestrian', 'footway', 'plaza'],
      paint: { 'fill-color': '#A0604A', 'fill-opacity': 0.10 },
    })
  }
  if (!map.getSource('isochrone')) {
    map.addSource('isochrone', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addLayer({
      id: 'isochrone-fill',
      type: 'fill',
      source: 'isochrone',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 },
    })
    map.addLayer({
      id: 'isochrone-line',
      type: 'line',
      source: 'isochrone',
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.7 },
    })
  }
}

// ── Surveyor mark SVG ─────────────────────────────────────────────────────────

function surveyorMarkSVG(color: string, fillColor: string): string {
  const cx = 24, cy = 24
  return `<svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="24" fill="none" stroke="${color}" stroke-width="0.8" class="surveyor-outer-ring"/>
    <circle cx="${cx}" cy="${cy}" r="18" fill="${fillColor}" stroke="${color}" stroke-width="1.2"/>
    <circle cx="${cx}" cy="${cy}" r="9" fill="${color}"/>
    <polygon points="${cx},2 ${cx - 4},9 ${cx + 4},9" fill="${color}"/>
  </svg>`
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function WalkIconSm() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Head */}
      <circle cx="9" cy="2.5" r="1.25"/>
      {/* Torso */}
      <path d="M 9 4 L 8 8"/>
      {/* Left arm (forward swing) */}
      <path d="M 8.5 5.5 L 6 7"/>
      {/* Right arm (back swing) */}
      <path d="M 8.5 5.5 L 11 6.5"/>
      {/* Left leg (forward) */}
      <path d="M 8 8 L 6 11 L 5 14"/>
      {/* Right leg (back) */}
      <path d="M 8 8 L 10 11 L 12 13"/>
    </svg>
  )
}

function BikeIconSm() {
  return (
    <svg width="16" height="14" viewBox="0 0 18 16" fill="none"
      stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="3.5"  cy="11" r="2.5"/>  {/* rear wheel */}
      <circle cx="14.5" cy="11" r="2.5"/>  {/* front wheel */}
      <path d="M 3.5 11 L 8 11"/>          {/* chainstay */}
      <path d="M 8 11 L 7.5 5"/>           {/* seat tube */}
      <path d="M 7.5 5 L 12 5.5"/>         {/* top tube */}
      <path d="M 12 7.5 L 8 11"/>          {/* down tube */}
      <path d="M 12 5.5 L 12 7.5"/>        {/* head tube */}
      <path d="M 12 7.5 L 14.5 11"/>       {/* fork */}
      <path d="M 7.5 5 L 3.5 11"/>         {/* seat stay */}
      <path d="M 7.5 5 L 7.5 3.5"/>        {/* seat post */}
      <path d="M 6 3.5 L 9 3.5"/>          {/* saddle */}
      <path d="M 12 5.5 L 12.5 3.5"/>      {/* stem */}
      <path d="M 11.2 3.5 L 13.8 3.5"/>    {/* handlebar */}
    </svg>
  )
}


function ShareIconSm() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Shaft */}
      <line x1="8" y1="2.5" x2="8" y2="10.5" />
      {/* Arrowhead — tighter, more balanced */}
      <polyline points="5.5,5 8,2.5 10.5,5" />
      {/* Tray — slightly inset, with rounded feel */}
      <path d="M3.5 9.5 L3.5 13 L12.5 13 L12.5 9.5" />
    </svg>
  )
}

// ── TimeDial ──────────────────────────────────────────────────────────────────

const TIMES = [5, 10, 15, 20, 25, 30]

function TimeDial({ value, accent, tok, onChange, onCommit }: {
  value: number
  accent: string
  tok: Tok
  onChange: (v: number) => void
  onCommit: (v: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  function snapToTick(raw: number): number {
    return TIMES.reduce((prev, t) => Math.abs(t - raw) < Math.abs(prev - raw) ? t : prev, TIMES[0])
  }

  function valueFromPointer(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return value
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return snapToTick(5 + pct * 25)
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
    onChange(valueFromPointer(e.clientX))
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    onChange(valueFromPointer(e.clientX))
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    dragging.current = false
    onCommit(valueFromPointer(e.clientX))
  }

  const pct = (value - 5) / 25

  return (
    <div
      ref={trackRef}
      style={{ position: 'relative', height: 46, padding: '0 4px', touchAction: 'none', cursor: 'pointer', userSelect: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Rail */}
      <div style={{ position: 'absolute', top: 20, left: 4, right: 4, height: 2, background: tok.borderSoft, borderRadius: 2 }} />
      {/* Active fill */}
      <div style={{ position: 'absolute', top: 20, left: 4, width: `calc(${pct * 100}% - ${pct * 8}px)`, height: 2, background: accent, borderRadius: 2, transition: 'width 0.08s ease' }} />
      {/* Ticks + labels */}
      {TIMES.map((tickVal, i) => {
        const left = (i / (TIMES.length - 1)) * 100
        const isActive = tickVal <= value
        return (
          <div key={tickVal} style={{ position: 'absolute', left: `${left}%`, top: 14, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, pointerEvents: 'none' }}>
            <div style={{ width: 1.5, height: 14, background: isActive ? accent : tok.dialTick }} />
            <span style={{ fontSize: 10, color: tickVal === value ? accent : tok.inkSoft, fontWeight: tickVal === value ? 600 : 400, fontFamily: 'Satoshi, system-ui, sans-serif' }}>
              {tickVal}
            </span>
          </div>
        )
      })}
      {/* Handle */}
      <div style={{ position: 'absolute', top: 12, left: `calc(${pct * 100}% - 9px)`, width: 18, height: 18, borderRadius: '50%', background: tok.markFill, border: `2px solid ${accent}`, boxShadow: '0 1px 3px rgba(0,0,0,0.12)', pointerEvents: 'none', transition: 'left 0.08s ease' }} />
    </div>
  )
}

// ── ModePillBar ───────────────────────────────────────────────────────────────

const MODE_COLOR: Record<string, string> = {
  walking: '#C97B3F',
  cycling: '#3F6B5E',
}
const AMBER_TINT = 'rgba(201,123,63,0.10)'
const SAGE_TINT  = 'rgba(63,107,94,0.10)'

function ModePillBar({ mode, units, tok, onChange }: {
  mode: string
  units: 'metric' | 'imperial'
  tok: Tok
  onChange: (m: string) => void
}) {
  const pills = [
    { id: 'walking', label: 'Walk', Icon: WalkIconSm, speed: WALK_SPEED_MS, tint: AMBER_TINT, accent: MODE_COLOR.walking },
    { id: 'cycling', label: 'Bike', Icon: BikeIconSm, speed: BIKE_SPEED_MS, tint: SAGE_TINT,  accent: MODE_COLOR.cycling },
  ]
  return (
    <div style={{ display: 'flex', gap: 0, background: tok.cardBg, borderRadius: 12, padding: 4, border: `1px solid ${tok.borderSoft}` }}>
      {pills.map(({ id, label, Icon, speed, tint, accent }) => {
        const active = mode === id
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: active ? tint : 'transparent',
              color: active ? accent : tok.inkSoft,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.2s',
              fontFamily: 'inherit',
            }}
          >
            <Icon />
            <span style={{ fontSize: 14, fontWeight: 500 }}>{label}</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{formatSpeedCap(speed, units)}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Segmented control (settings) ──────────────────────────────────────────────

function SegControl({ options, value, onChange, tok, accent = '#3F6B5E' }: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
  tok: Tok
  accent?: string
}) {
  return (
    <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: `1px solid ${tok.borderSoft}` }}>
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            padding: '5px 12px',
            background: value === opt.value ? `${accent}1e` : 'transparent',
            border: 'none',
            borderRight: i < options.length - 1 ? `1px solid ${tok.borderSoft}` : 'none',
            color: value === opt.value ? accent : tok.inkSoft,
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap' as const,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ── Onboarding sheet ──────────────────────────────────────────────────────────

function OnboardingSheet({ tok, onDismiss }: { tok: Tok; onDismiss: () => void }) {
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onDismiss}
        style={{ position: 'absolute', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.2)' }}
      />
      {/* Ripple rings */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 91, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="340" height="340" viewBox="0 0 340 340" style={{ position: 'absolute' }}>
          {[0, 1, 2].map(i => (
            <circle
              key={i}
              cx="170" cy="170"
              r={60 + i * 50}
              fill="none"
              stroke={MODE_COLOR.walking}
              strokeWidth="1"
              strokeDasharray="3 4"
              className={`ripple-ring ripple-ring-${i}`}
            />
          ))}
        </svg>
      </div>
      {/* Sheet */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 100,
        background: tok.parchmentSheet, backdropFilter: 'blur(20px)',
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        padding: '20px 22px calc(32px + env(safe-area-inset-bottom))',
        boxShadow: '0 -4px 20px rgba(0,0,0,0.04)',
      }}>
        {/* Handle */}
        <div style={{ width: 36, height: 4, background: tok.handleBar, borderRadius: 2, margin: '0 auto 20px' }} />
        {/* Eyebrow */}
        <div style={{ fontSize: 10, letterSpacing: '2px', textTransform: 'uppercase', color: MODE_COLOR.walking, fontFamily: 'ui-monospace, Menlo, monospace', marginBottom: 10 }}>
          Emanare · To flow out
        </div>
        {/* Headline */}
        <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 30, lineHeight: 1.15, letterSpacing: '-0.4px', color: tok.text, marginBottom: 10 }}>
          Your world,<br />within reach.
        </div>
        {/* Body */}
        <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic', fontSize: 15, lineHeight: 1.55, color: tok.inkSoft, marginBottom: 20 }}>
          You don't always know where you're going. Emanant draws what's reachable from where you are — so you can wander with intention.
        </div>
        {/* Permission card */}
        <div
          onClick={onDismiss}
          style={{
            background: tok.cardBg, borderRadius: 12, border: `1px solid ${tok.borderSoft}`,
            padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14,
            cursor: 'pointer', marginBottom: 16,
          }}
        >
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(92,138,124,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5C8A7C" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="3"/>
              <line x1="12" y1="2" x2="12" y2="5"/>
              <line x1="12" y1="19" x2="12" y2="22"/>
              <line x1="2" y1="12" x2="5" y2="12"/>
              <line x1="19" y1="12" x2="22" y2="12"/>
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: tok.text }}>Use my location</div>
            <div style={{ fontSize: 12, color: tok.inkSoft }}>Your precise location stays on this device.</div>
          </div>
          <span style={{ color: tok.inkSoft, fontSize: 16 }}>›</span>
        </div>
        {/* Footer */}
        <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic', fontSize: 11, color: tok.inkSoft, textAlign: 'center' }}>
          No account · No personal data · Anonymous analytics
        </div>
      </div>
    </>
  )
}

// ── Error view ────────────────────────────────────────────────────────────────

function ErrorView({ tok, onRetry, onBrowse }: { tok: Tok; onRetry: () => void; onBrowse: () => void }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '0 36px', background: tok.parchmentSheet, backdropFilter: 'blur(8px)',
    }}>
      {/* Broken compass — strokes in inkSoft, readable on both themes */}
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" style={{ marginBottom: 24 }}>
        <circle cx="36" cy="36" r="32" stroke={tok.inkSoft} strokeWidth="1" strokeDasharray="4 4"/>
        <circle cx="36" cy="36" r="22" stroke={tok.inkSoft} strokeWidth="1.5"/>
        <line x1="36" y1="14" x2="36" y2="36" stroke={tok.inkSoft} strokeWidth="2" strokeLinecap="round" opacity="0.4"/>
        <line x1="36" y1="36" x2="52" y2="52" stroke={tok.inkSoft} strokeWidth="2" strokeLinecap="round" opacity="0.25"/>
        <circle cx="36" cy="36" r="3" fill={tok.inkSoft}/>
      </svg>
      <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 26, lineHeight: 1.2, color: tok.text, textAlign: 'center', marginBottom: 12 }}>
        We can't find<br />where you stand.
      </div>
      <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic', fontSize: 14, color: tok.inkSoft, textAlign: 'center', lineHeight: 1.5, marginBottom: 28 }}>
        Emanant needs your location to draw your reach. Your precise location stays on this device.
      </div>
      <button
        onClick={onRetry}
        style={{
          padding: '12px 22px', borderRadius: 10, border: 'none', cursor: 'pointer',
          background: MODE_COLOR.cycling, color: '#F2EBDD', fontSize: 14, fontWeight: 500,
          fontFamily: 'inherit', marginBottom: 14,
        }}
      >
        Use my location
      </button>
      <button
        onClick={onBrowse}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: tok.inkSoft, textDecoration: 'underline', fontFamily: 'inherit' }}
      >
        Or browse a sample map →
      </button>
    </div>
  )
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODES: { id: string; label: string }[] = [
  { id: 'walking', label: 'Walk' },
  { id: 'cycling', label: 'Bike' },
]

const EXCLUDE_TYPES = new Set(['country', 'state', 'region', 'country_subdivision', 'city'])
const REACH_CAP     = 12

// ── Types ────────────────────────────────────────────────────────────────────

interface ReachNeighborhood {
  name: string
  bearing: number
  cardinal: string
  arrow: string
  distanceM: number
}

// ── Component ────────────────────────────────────────────────────────────────

// ── Cookie consent banner ─────────────────────────────────────────────────────

function CookieBanner({ tok, onAccept, onDecline }: { tok: Tok; onAccept: () => void; onDecline: () => void }) {
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
      background: tok.bg, borderTop: `1px solid ${tok.borderSoft}`,
      padding: '14px 20px',
      paddingBottom: 'calc(14px + env(safe-area-inset-bottom))',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic', fontSize: 13, color: tok.inkSoft, lineHeight: 1.5 }}>
        We use anonymous analytics to understand how the app is used.{' '}
        <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{ color: tok.inkSoft }}>Privacy Policy</a>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onDecline}
          style={{ padding: '7px 16px', borderRadius: 8, border: `1px solid ${tok.btnBorder}`, background: tok.btnBg, color: tok.btnText, fontSize: 13, cursor: 'pointer' }}
        >Decline</button>
        <button
          onClick={onAccept}
          style={{ padding: '7px 16px', borderRadius: 8, border: `1px solid ${tok.btnBorder}`, background: tok.btnBg, color: tok.btnText, fontSize: 13, cursor: 'pointer' }}
        >Accept</button>
      </div>
    </div>
  )
}

export default function App() {
  const containerRef      = useRef<HTMLDivElement>(null)
  const mapRef            = useRef<mapboxgl.Map | null>(null)
  const markerRef         = useRef<mapboxgl.Marker | null>(null)
  const lastFetchedRef    = useRef<[number, number] | null>(null)
  const firstFixRef       = useRef(true)
  const lastHeadingRef    = useRef<number | null>(null)
  const dialDebounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modeRef           = useRef('walking')
  const darkRef           = useRef(false)

  const [themeMode,  setThemeMode]  = useState<'light' | 'system' | 'dark'>(
    () => (localStorage.getItem('theme') as 'light' | 'system' | 'dark') ?? 'system'
  )
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const dark = themeMode === 'dark' || (themeMode === 'system' && systemDark)

  const currentMapStyleRef = useRef(dark ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11')

  const [mapReady,       setMapReady]       = useState(false)
  const [location,       setLocation]       = useState<[number, number] | null>(null)
  const [mode,           setMode]           = useState('walking')
  const [minutes,        setMinutes]        = useState(15)
  const [dialMinutes,    setDialMinutes]    = useState(15)
  const [loading,        setLoading]        = useState(false)
  const [locError,       setLocError]       = useState(false)
  const [neighborhood,   setNeighborhood]   = useState<string | null>(null)
  const [city,           setCity]           = useState<string | null>(null)
  const [reachList,      setReachList]      = useState<ReachNeighborhood[]>([])
  const [listExpanded,   setListExpanded]   = useState(false)
  const [heading,        setHeading]        = useState<number | null>(null)
  const [compassEnabled, setCompassEnabled] = useState(false)
  const [settingsOpen,   setSettingsOpen]   = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [onboarded,      setOnboarded]      = useState(() => !!localStorage.getItem('onboarded'))
  const [cookieConsent,  setCookieConsent]  = useState<'accepted' | 'declined' | null>(
    () => localStorage.getItem('cookie-consent') as 'accepted' | 'declined' | null
  )
  const [units,          setUnits]          = useState<'metric' | 'imperial'>(
    () => (localStorage.getItem('units') as 'metric' | 'imperial') ?? 'metric'
  )
  const [showSpaces,     setShowSpaces]     = useState(true)
  const [sharedLocation, setSharedLocation] = useState<[number, number] | null>(null)
  const [shareToast,     setShareToast]     = useState<'idle' | 'copied' | 'shared'>('idle')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [isoData,        setIsoData]        = useState<any>(null)

  const effectiveLocation = sharedLocation ?? location

  const t = useMemo(() => tok(dark), [dark])

  // Keep refs in sync for use inside effects with stale closures
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { darkRef.current = dark }, [dark])
  useEffect(() => { setDialMinutes(minutes) }, [minutes])

  // ── Parse shared URL on mount ─────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const loc = params.get('loc')
    if (!loc) return
    const coords = deobfuscateCoords(loc)
    if (!coords) return
    setSharedLocation(coords)
    setLocation(coords)
    firstFixRef.current = false
    const m = params.get('m')
    if (m && ['walking', 'cycling'].includes(m)) setMode(m)
    const tParam = parseInt(params.get('t') ?? '', 10)
    if (TIMES.includes(tParam)) setMinutes(tParam)
  }, [])

  // ── System dark mode listener ─────────────────────────────────────────────
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // ── Apply theme to body ───────────────────────────────────────────────────
  useEffect(() => {
    document.body.style.background = t.bodyBg
  }, [t])

  // ── Map style change when theme toggles ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const newStyle = t.mapStyle
    if (currentMapStyleRef.current === newStyle) return
    currentMapStyleRef.current = newStyle
    setMapReady(false)
    setReachList([])
    map.once('style.load', () => {
      addMapLayers(map)
      if (!showSpaces) {
        ;['parks-fill', 'parks-outline', 'public-spaces-fill'].forEach(id => {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none')
        })
      }
      map.setPaintProperty('isochrone-fill', 'fill-color', MODE_COLOR[mode])
      map.setPaintProperty('isochrone-line', 'line-color', MODE_COLOR[mode])
      setMapReady(true)
    })
    map.setStyle(newStyle)
  }, [t.mapStyle, mapReady, mode, showSpaces])

  // ── Update surveyor mark when mode or theme changes ───────────────────────
  useEffect(() => {
    const el = markerRef.current?.getElement()
    if (!el) return
    el.innerHTML = surveyorMarkSVG(MODE_COLOR[mode], t.markFill)
  }, [mode, t.markFill])

  // ── Init map + GPS polling ────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !TOKEN) return

    mapboxgl.accessToken = TOKEN

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: currentMapStyleRef.current,
      zoom: 13,
      center: [-0.1276, 51.5074],
      antialias: true,
    })
    mapRef.current = map

    map.on('load', () => {
      addMapLayers(map)
      setMapReady(true)
    })

    function handlePosition({ coords }: GeolocationPosition) {
      const lnglat: [number, number] = [coords.longitude, coords.latitude]

      if (markerRef.current) {
        markerRef.current.setLngLat(lnglat)
      } else {
        const el = document.createElement('div')
        el.style.cssText = 'width:48px;height:48px;cursor:pointer'
        el.innerHTML = surveyorMarkSVG(MODE_COLOR[modeRef.current], darkRef.current ? '#1a1916' : '#F2EBDD')
        markerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat(lnglat)
          .addTo(map)
      }

      if (firstFixRef.current) {
        firstFixRef.current = false
        map.flyTo({ center: lnglat, zoom: 14, duration: 1000 })
        fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lnglat[0]},${lnglat[1]}.json` +
          `?types=neighborhood,locality,place&access_token=${TOKEN}`
        )
          .then(r => r.json())
          .then(data => {
            const feat = data.features?.[0]
            if (feat?.text) setNeighborhood(feat.text)
            const cityCtx = feat?.context?.find((c: { id: string; text: string }) => c.id.startsWith('place.'))
            if (cityCtx?.text) setCity(cityCtx.text)
          })
          .catch(() => {})
      }

      const last = lastFetchedRef.current
      if (!last || last[0] !== lnglat[0] || last[1] !== lnglat[1]) {
        if (!last || metersApart(last, lnglat) >= MOVE_THRESHOLD_M) {
          lastFetchedRef.current = lnglat
          setLocation(lnglat)
        }
      }
    }

    const geoOpts: PositionOptions = { enableHighAccuracy: true, timeout: 10_000 }
    navigator.geolocation.getCurrentPosition(handlePosition, () => setLocError(true), geoOpts)
    const intervalId = setInterval(
      () => navigator.geolocation.getCurrentPosition(handlePosition, () => {}, geoOpts),
      LOCATION_INTERVAL_MS
    )

    return () => {
      clearInterval(intervalId)
      markerRef.current?.remove()
      map.remove()
    }
  }, [])

  // ── Sync isochrone layer colors with mode ─────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const color = MODE_COLOR[mode]
    map.setPaintProperty('isochrone-fill', 'fill-color', color)
    map.setPaintProperty('isochrone-line', 'line-color', color)
  }, [mode, mapReady])

  // ── Fetch isochrone + neighborhood reach list ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !effectiveLocation || !map || !TOKEN) return

    let cancelled = false
    setLoading(true)
    setReachList([])

    const [lng, lat] = effectiveLocation
    const isoUrl =
      `https://api.mapbox.com/isochrone/v1/mapbox/${mode}/${lng},${lat}` +
      `?contours_minutes=${minutes}&polygons=true&access_token=${TOKEN}`

    fetch(isoUrl)
      .then(r => { if (!r.ok) throw new Error('iso'); return r.json() })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((data: any) => {
        if (cancelled) return
        ;(map.getSource('isochrone') as mapboxgl.GeoJSONSource)?.setData(data)
        setIsoData(data)
        gtag('event', 'isochrone_rendered', {
          mode,
          duration_min: minutes,
          neighborhood: neighborhood ?? undefined,
          city: city ?? undefined,
        })

        const ring = data.features?.[0]?.geometry?.coordinates?.[0] as [number, number][] | undefined
        if (ring?.length) {
          const lngs = ring.map(([x]: [number, number]) => x)
          const lats = ring.map(([, y]: [number, number]) => y)
          map.fitBounds(
            [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
            { padding: { top: 80, bottom: panelCollapsed ? 60 : 300, left: 20, right: 20 }, duration: 800 }
          )
        }

        const isoRadius  = isochroneRadius([lng, lat], data)
        const nBoundary  = isoRadius < 2_000 ? 0 : 4
        const samples    = isoSamplePoints([lng, lat], data, nBoundary)
        const queryRadius = Math.min(Math.ceil(isoRadius * 0.7), 10_000)

        const tqRequests = samples.map(([qLng, qLat]) =>
          fetch(
            `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${qLng},${qLat}.json` +
            `?radius=${queryRadius}&limit=50&layers=place_label&access_token=${TOKEN}`
          ).then(r => r.ok ? r.json() : { features: [] })
        )

        return Promise.all(tqRequests).then(responses => {
          if (cancelled) return
          const isoGeom = data.features?.[0]?.geometry
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const allFeatures = responses.flatMap((r: any) => r.features ?? [])

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hits: ReachNeighborhood[] = allFeatures
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((f: any) => !EXCLUDE_TYPES.has(f.properties?.type ?? f.properties?.class ?? ''))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((f: any) => {
              const coords = f.geometry?.coordinates as [number, number] | undefined
              return coords ? pointInFeature(coords, isoGeom) : false
            })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((f: any) => {
              const coords = f.geometry.coordinates as [number, number]
              const name: string = f.properties?.name ?? f.properties?.text ?? ''
              const b = bearingTo([lng, lat], coords)
              const { cardinal, arrow } = toCardinal(b)
              return { name, bearing: b, cardinal, arrow, distanceM: metersApart([lng, lat], coords) }
            })
            .sort((a: ReachNeighborhood, b: ReachNeighborhood) => a.distanceM - b.distanceM)

          const seen = new Set<string>()
          const unique = hits.filter((h: ReachNeighborhood) => {
            if (!h.name || seen.has(h.name)) return false
            seen.add(h.name)
            return true
          })

          setReachList(unique.slice(0, REACH_CAP))
        })
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [mapReady, effectiveLocation, mode, minutes])

  // ── Compass rotation reset ────────────────────────────────────────────────
  useEffect(() => {
    if (!compassEnabled) {
      markerRef.current?.setRotation(0)
      setHeading(null)
      lastHeadingRef.current = null
    }
  }, [compassEnabled])

  // ── Device orientation listener ───────────────────────────────────────────
  useEffect(() => {
    if (!compassEnabled) return
    function handleOrientation(e: DeviceOrientationEvent) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = e as any
      let h: number | null = null
      if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading
      else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360
      if (h === null) return
      markerRef.current?.setRotation(h)
      const last = lastHeadingRef.current
      if (last === null || Math.abs(h - last) > 5) {
        lastHeadingRef.current = h
        setHeading(Math.round(h))
      }
    }
    window.addEventListener('deviceorientation', handleOrientation, true)
    return () => window.removeEventListener('deviceorientation', handleOrientation, true)
  }, [compassEnabled])

  // ── iOS compass permission ────────────────────────────────────────────────
  async function requestCompass() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DOE = DeviceOrientationEvent as any
    if (typeof DOE.requestPermission === 'function') {
      const result: string = await DOE.requestPermission()
      if (result === 'granted') setCompassEnabled(true)
    } else {
      setCompassEnabled(true)
    }
  }

  function setTheme(m: 'light' | 'system' | 'dark') {
    setThemeMode(m)
    localStorage.setItem('theme', m)
  }

  function toggleUnits() {
    const next = units === 'metric' ? 'imperial' : 'metric'
    setUnits(next)
    localStorage.setItem('units', next)
    gtag('event', 'units_toggled', { units: next })
  }

  function toggleSpaces() {
    const next = !showSpaces
    setShowSpaces(next)
    const map = mapRef.current
    if (map) {
      const ids = ['parks-fill', 'parks-outline', 'public-spaces-fill']
      ids.forEach(id => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', next ? 'visible' : 'none')
      })
    }
  }

  function dismissOnboarding() {
    localStorage.setItem('onboarded', '1')
    setOnboarded(true)
    gtag('event', 'onboarding_dismissed', {})
  }

  function handleDialChange(v: number) {
    setDialMinutes(v)
    if (dialDebounceRef.current) clearTimeout(dialDebounceRef.current)
    dialDebounceRef.current = setTimeout(() => {
      setMinutes(v)
      gtag('event', 'duration_changed', { mode, duration_min: v })
    }, 250)
  }

  function handleDialCommit(v: number) {
    setDialMinutes(v)
    if (dialDebounceRef.current) clearTimeout(dialDebounceRef.current)
    setMinutes(v)
    gtag('event', 'duration_changed', { mode, duration_min: v })
  }

  function handleModeChange(m: string) {
    setMode(m)
    gtag('event', 'mode_changed', { mode: m, duration_min: minutes })
  }

  function requestLocation() {
    const geoOpts: PositionOptions = { enableHighAccuracy: true, timeout: 10_000 }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const lnglat: [number, number] = [coords.longitude, coords.latitude]
        setLocation(lnglat)
        setLocError(false)
        firstFixRef.current = true
      },
      () => setLocError(true),
      geoOpts
    )
  }

  function browseAsGuest() {
    setSharedLocation([-0.1276, 51.5074])
    setLocError(false)
    firstFixRef.current = false
  }

  function dismissSharedLocation() {
    setSharedLocation(null)
    firstFixRef.current = true
    window.history.replaceState({}, '', window.location.pathname)
    gtag('event', 'shared_location_dismissed', {})
  }

  async function handleShare() {
    if (!effectiveLocation) return
    const [lng, lat] = effectiveLocation
    const url = `${window.location.origin}${window.location.pathname}?loc=${obfuscateCoords(lat, lng)}&m=${mode}&t=${minutes}`
    const reachR = isoData ? isochroneRadius(effectiveLocation, isoData) : null
    const reachStr = reachR ? formatDistance(reachR, units) : null
    const modeLabel = mode === 'walking' ? 'walking' : 'cycling'
    const title = reachStr && neighborhood
      ? `I can reach ${reachStr} in ${minutes} min ${modeLabel} from ${neighborhood} — emanant.app`
      : 'My reachable area — Emanant'
    if (navigator.share) {
      try {
        await navigator.share({ title, url })
        setShareToast('shared')
      } catch { /* user cancelled */ }
    } else {
      await navigator.clipboard.writeText(url)
      setShareToast('copied')
    }
    setTimeout(() => setShareToast('idle'), 2000)
    gtag('event', 'isochrone_shared', { mode, duration_min: minutes })
  }

  // ── Cookie consent ───────────────────────────────────────────────────────
  function acceptCookies() {
    localStorage.setItem('cookie-consent', 'accepted')
    setCookieConsent('accepted')
    ;(window as Window & { ['ga-disable-G-8RZBC984QD']?: boolean })['ga-disable-G-8RZBC984QD'] = false
    gtag('config', 'G-8RZBC984QD')
  }
  function declineCookies() {
    localStorage.setItem('cookie-consent', 'declined')
    setCookieConsent('declined')
    ;(window as Window & { ['ga-disable-G-8RZBC984QD']?: boolean })['ga-disable-G-8RZBC984QD'] = true
  }

  // ── No token screen ───────────────────────────────────────────────────────
  if (!TOKEN) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, padding: 28 }}>
        <div style={{ fontSize: 40 }}>🗺️</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Mapbox token required</div>
        <div style={{ fontSize: 14, color: t.textMuted, maxWidth: 280, textAlign: 'center', lineHeight: 1.5 }}>
          Copy <code style={{ fontFamily: 'ui-monospace, "SF Mono", monospace', fontSize: 13, background: t.codeBg, border: `1px solid ${t.codeBorder}`, borderRadius: 8, padding: '2px 7px', color: t.codeText }}>.env.example</code> to <code style={{ fontFamily: 'ui-monospace, "SF Mono", monospace', fontSize: 13, background: t.codeBg, border: `1px solid ${t.codeBorder}`, borderRadius: 8, padding: '2px 7px', color: t.codeText }}>.env</code> and add your public token
        </div>
      </div>
    )
  }

  const color = MODE_COLOR[mode]
  const reachRadius = effectiveLocation && isoData ? isochroneRadius(effectiveLocation, isoData) : null

  const sheetHeight = panelCollapsed
    ? 'calc(28px + env(safe-area-inset-bottom))'
    : settingsOpen
      ? 'calc(420px + env(safe-area-inset-bottom))'
      : 'calc(225px + env(safe-area-inset-bottom))'

  return (
    <div style={{
      height: '100%', position: 'relative',
      ['--mapctrl-bottom' as string]: listExpanded
        ? 'calc(100vh + 40px)'
        : panelCollapsed
          ? 'calc(33px + env(safe-area-inset-bottom))'
          : settingsOpen
            ? 'calc(465px + env(safe-area-inset-bottom))'
            : 'calc(250px + env(safe-area-inset-bottom))',
    }}>

      {/* Map */}
      <div
        ref={containerRef}
        style={{
          position: 'absolute', inset: 0,
          opacity: listExpanded ? 0.35 : 1,
          transition: 'opacity 0.3s ease-out',
        }}
      />

      {/* ── Top overlays ── */}

      {/* Place chip */}
      {neighborhood && effectiveLocation && (
        <div style={{
          position: 'absolute', top: 14, left: 14, right: 14, zIndex: 10,
          background: t.placeChipBg, backdropFilter: 'blur(8px)',
          border: '1px solid rgba(0,0,0,0.04)', borderRadius: 12, padding: '10px 14px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 16, color: t.text, lineHeight: 1 }}>
            {neighborhood}
          </span>
          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: t.inkSoft, letterSpacing: '0.5px' }}>
            {formatLatLon(effectiveLocation)}
          </span>
        </div>
      )}

      {/* Neighborhoods pill */}
      {reachList.length > 0 && (
        <button
          onClick={() => { if (!listExpanded) gtag('event', 'reach_list_expanded', {}); setListExpanded(x => !x) }}
          style={{
            position: 'absolute', top: 66, left: 14, zIndex: 10,
            background: t.placeChipBg, backdropFilter: 'blur(8px)',
            border: '1px solid rgba(0,0,0,0.04)', borderRadius: 999, padding: '7px 14px 7px 12px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            display: 'flex', alignItems: 'center', gap: 7,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic', fontSize: 12, color: t.inkSoft }}>
            {reachList.length} neighborhood{reachList.length !== 1 ? 's' : ''}
          </span>
          <span style={{ fontSize: 11, color: t.inkSoft, display: 'inline-block', transform: listExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
            ↑
          </span>
        </button>
      )}

      {/* Compass heading pill */}
      {compassEnabled && heading !== null && (
        <div style={{
          position: 'absolute', top: 66, right: 14, zIndex: 10,
          background: t.placeChipBg, backdropFilter: 'blur(8px)',
          border: '1px solid rgba(0,0,0,0.04)', borderRadius: 999, padding: '7px 14px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: t.inkSoft,
        }}>
          ↑ {toCardinal(heading).cardinal}
        </div>
      )}

      {/* Loading pill */}
      {loading && (
        <div style={{
          position: 'absolute', top: 66, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
          background: t.placeChipBg, backdropFilter: 'blur(8px)',
          border: '1px solid rgba(0,0,0,0.04)', borderRadius: 999, padding: '7px 14px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div className="loading-dot" />
          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: t.inkSoft }}>Calculating…</span>
        </div>
      )}

      {/* Places drawer */}
      {listExpanded && (
        <>
          <div
            onClick={() => setListExpanded(false)}
            style={{ position: 'absolute', inset: 0, zIndex: 19 }}
          />
          <div style={{
            position: 'absolute', top: 60, left: 0, right: 0, bottom: 0, zIndex: 20,
            background: t.parchmentSheet, backdropFilter: 'blur(20px)',
            borderTopLeftRadius: 24, borderTopRightRadius: 24,
            boxShadow: '0 -4px 20px rgba(0,0,0,0.04)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Handle */}
            <div style={{ flexShrink: 0, padding: '14px 22px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div
                onClick={() => setListExpanded(false)}
                style={{ width: 36, height: 4, background: t.handleBar, borderRadius: 2, margin: '0 auto', cursor: 'pointer' }}
              />
              <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 22, color: t.text, letterSpacing: '-0.3px', lineHeight: 1.2 }}>
                Within reach
              </div>
              <div style={{ fontFamily: 'Satoshi, system-ui, sans-serif', fontSize: 12, color: t.inkSoft }}>
                {reachList.length} neighborhood{reachList.length !== 1 ? 's' : ''} within {minutes} min {mode === 'walking' ? 'walk' : 'bike'}
              </div>
            </div>
            {/* List */}
            <div style={{ flex: 1, overflowY: 'auto', paddingTop: 8 }}>
              {reachList.map(item => (
                <div
                  key={item.name}
                  style={{
                    display: 'grid', gridTemplateColumns: '32px 32px 1fr auto auto',
                    gap: 10, padding: '14px 22px',
                    borderBottom: `1px solid ${t.borderFaint}`,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: 18, color, textAlign: 'center' }}>{item.arrow}</span>
                  <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 10, color: t.inkSoft, letterSpacing: '0.6px' }}>{item.cardinal}</span>
                  <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 16, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: t.inkSoft, whiteSpace: 'nowrap' }}>{formatDistance(item.distanceM, units)}</span>
                  <span style={{ fontFamily: 'Satoshi, system-ui, sans-serif', fontSize: 11, color: t.inkSoft, whiteSpace: 'nowrap' }}>{walkTimeMin(item.distanceM, mode)} min</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Shared location banner */}
      {sharedLocation && (
        <div style={{
          position: 'absolute', top: 14, left: 14, right: 14, zIndex: 11,
          background: dark ? 'rgba(99,102,241,0.12)' : 'rgba(99,102,241,0.08)',
          border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: 12, padding: '10px 14px',
          color: dark ? '#a5b4fc' : '#4f46e5',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 13,
        }}>
          <span>Viewing a shared location</span>
          <button
            onClick={dismissSharedLocation}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, padding: '0 0 0 12px', fontFamily: 'inherit', opacity: 0.75, whiteSpace: 'nowrap' }}
          >
            Use my location ×
          </button>
        </div>
      )}

      {/* Location error — full-screen calm view */}
      {locError && !sharedLocation && (
        <ErrorView tok={t} onRetry={requestLocation} onBrowse={browseAsGuest} />
      )}

      {/* Onboarding */}
      {!onboarded && <OnboardingSheet tok={t} onDismiss={dismissOnboarding} />}

      {/* ── Bottom sheet ── */}
      {!locError && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: t.parchmentSheet, backdropFilter: 'blur(12px)',
          borderTop: '1px solid rgba(0,0,0,0.05)',
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          padding: `14px 18px calc(14px + env(safe-area-inset-bottom))`,
          zIndex: 10,
          transition: 'padding 0.2s ease',
          minHeight: sheetHeight,
          boxSizing: 'border-box' as const,
          boxShadow: '0 -4px 20px rgba(0,0,0,0.04)',
        }}>

          {/* Drag handle */}
          <div
            onClick={() => setPanelCollapsed(x => !x)}
            style={{ cursor: 'pointer', paddingBottom: panelCollapsed ? 0 : 14 }}
            aria-label={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
          >
            <div style={{ width: 36, height: 4, background: t.handleBar, borderRadius: 2, margin: '0 auto' }} />
          </div>

          {!panelCollapsed && (
            <>
              {/* Reach reading row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 28, color: t.text, letterSpacing: '-0.3px', lineHeight: 1 }}>
                    {dialMinutes}
                    <span style={{ fontSize: 18, color: t.inkSoft, marginLeft: 2 }}>min</span>
                  </div>
                  {reachRadius !== null && reachRadius > 0 && (
                    <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: t.inkSoft, letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                      ≈ {formatDistance(reachRadius, units)} reach
                    </div>
                  )}
                </div>
                {/* Share button */}
                <button
                  onClick={handleShare}
                  disabled={!effectiveLocation}
                  aria-label="Share isochrone"
                  style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: shareToast !== 'idle' ? `${color}22` : t.cardBg,
                    border: `1px solid ${t.borderSoft}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: effectiveLocation ? 'pointer' : 'default',
                    opacity: effectiveLocation ? 1 : 0.3,
                    color: shareToast !== 'idle' ? color : t.text,
                    transition: 'all 0.2s',
                    flexShrink: 0,
                  }}
                >
                  {shareToast !== 'idle'
                    ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    : <ShareIconSm />
                  }
                </button>
              </div>

              {/* Time dial */}
              <TimeDial
                value={dialMinutes}
                accent={color}
                tok={t}
                onChange={handleDialChange}
                onCommit={handleDialCommit}
              />

              {/* Mode segmented bar */}
              <div style={{ marginTop: 16 }}>
                <ModePillBar mode={mode} units={units} tok={t} onChange={handleModeChange} />
              </div>

              {/* Settings collapsible */}
              <div style={{ marginTop: 14, borderTop: '1px solid rgba(0,0,0,0.05)', paddingTop: 12 }}>
                <div
                  onClick={() => { if (!settingsOpen) gtag('event', 'settings_opened', {}); setSettingsOpen(x => !x) }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={t.inkSoft} strokeWidth="1.3">
                      <circle cx="8" cy="8" r="2"/>
                      <path d="M 8 1 L 8 3 M 8 13 L 8 15 M 1 8 L 3 8 M 13 8 L 15 8 M 3 3 L 4.5 4.5 M 11.5 11.5 L 13 13 M 3 13 L 4.5 11.5 M 11.5 4.5 L 13 3"/>
                    </svg>
                    <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic', fontSize: 13, color: t.inkSoft }}>Settings</span>
                  </div>
                  <span style={{ fontSize: 11, color: t.inkSoft, display: 'inline-block', transform: settingsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>⌄</span>
                </div>

                {settingsOpen && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Appearance */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: t.inkSoft }}>Appearance</span>
                      <SegControl tok={t}
                        options={[{ value: 'light', label: 'Light' }, { value: 'system', label: 'Auto' }, { value: 'dark', label: 'Dark' }]}
                        value={themeMode}
                        onChange={v => setTheme(v as 'light' | 'system' | 'dark')}
                      />
                    </div>
                    {/* Units */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: t.inkSoft }}>Units</span>
                      <SegControl tok={t}
                        options={[{ value: 'metric', label: 'km' }, { value: 'imperial', label: 'mi' }]}
                        value={units}
                        onChange={v => { if (v !== units) toggleUnits() }}
                      />
                    </div>
                    {/* Live compass */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: t.inkSoft }}>Live compass</span>
                      <SegControl tok={t}
                        options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
                        value={compassEnabled ? 'on' : 'off'}
                        onChange={v => { if (v === 'on' && !compassEnabled) requestCompass(); else if (v === 'off') setCompassEnabled(false) }}
                      />
                    </div>
                    {/* Spaces */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: t.inkSoft }}>Spaces</span>
                      <SegControl tok={t}
                        options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
                        value={showSpaces ? 'on' : 'off'}
                        onChange={v => { if ((v === 'on') !== showSpaces) toggleSpaces() }}
                      />
                    </div>
                    {/* Analytics */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: t.inkSoft }}>Analytics</span>
                      <SegControl tok={t}
                        options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
                        value={cookieConsent === 'accepted' ? 'on' : 'off'}
                        onChange={v => v === 'on' ? acceptCookies() : declineCookies()}
                      />
                    </div>
                    {/* Footer */}
                    <div style={{ marginTop: 4, fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic', fontSize: 11, color: t.inkSoft, textAlign: 'center', lineHeight: 1.5 }}>
                      No account · No personal data collected
                    </div>
                    <div style={{ fontSize: 11, color: t.subduedFg, opacity: 0.6, textAlign: 'center' }}>
                      <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{ color: t.subduedFg, textDecoration: 'underline', cursor: 'pointer' }}>Privacy</a>
                      <span style={{ margin: '0 6px' }}>·</span>
                      <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{ color: t.subduedFg, textDecoration: 'underline', cursor: 'pointer' }}>Terms</a>
                      <span style={{ margin: '0 6px' }}>·</span>
                      <a
                        href="https://docs.google.com/forms/d/e/1FAIpQLScctFaGMLcVCsBJFx93rlDqFJweH5F_o8_0vNqI0rvB1fHd1w/viewform?usp=sharing&ouid=100968712771359852520"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => gtag('event', 'feedback_clicked', {})}
                        style={{ color: t.subduedFg, textDecoration: 'underline', cursor: 'pointer' }}
                      >
                        Share feedback
                      </a>
                      <span style={{ margin: '0 6px' }}>·</span>
                      © {new Date().getFullYear()} Emanant.app
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {onboarded && cookieConsent === null && (
        <CookieBanner tok={t} onAccept={acceptCookies} onDecline={declineCookies} />
      )}
    </div>
  )
}
