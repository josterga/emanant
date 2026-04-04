import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

const MODES: { id: string; label: string; icon: string }[] = [
  { id: 'walking', label: 'Walk',  icon: '🚶' },
  { id: 'cycling', label: 'Bike',  icon: '🚴' },
  { id: 'driving', label: 'Drive', icon: '🚗' },
]

const TIMES = [5, 10, 15, 20, 30]

// Colors per mode
const MODE_COLOR: Record<string, string> = {
  walking: '#FF6B35',
  cycling: '#10B981',
  driving: '#6366F1',
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef       = useRef<mapboxgl.Map | null>(null)
  const markerRef    = useRef<mapboxgl.Marker | null>(null)

  const [mapReady,  setMapReady]  = useState(false)
  const [mapError,  setMapError]  = useState<string | null>(null)
  const [location,  setLocation]  = useState<[number, number] | null>(null)
  const [mode,      setMode]      = useState('walking')
  const [minutes,   setMinutes]   = useState(10)
  const [loading,   setLoading]   = useState(false)
  const [locError,  setLocError]  = useState(false)

  // ── Init map ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !TOKEN) return

    mapboxgl.accessToken = TOKEN

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      zoom: 13,
      center: [-0.1276, 51.5074], // fallback: London
      antialias: true,
    })
    mapRef.current = map

    map.on('error', (e) => {
      const err = e.error as Error & { status?: number }
      if (err?.status === 401 || err?.message?.toLowerCase().includes('unauthorized')) {
        setMapError('Map failed to load — token may be invalid or domain-restricted.')
      }
    })

    map.on('load', () => {
      // Isochrone GeoJSON source
      map.addSource('isochrone', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      // Fill layer
      map.addLayer({
        id: 'isochrone-fill',
        type: 'fill',
        source: 'isochrone',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.14,
        },
      })

      // Border layer
      map.addLayer({
        id: 'isochrone-line',
        type: 'line',
        source: 'isochrone',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.7,
        },
      })

      setMapReady(true)
    })

    // Get user location
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const lnglat: [number, number] = [coords.longitude, coords.latitude]
        setLocation(lnglat)
        map.flyTo({ center: lnglat, zoom: 14, duration: 1000 })

        const el = document.createElement('div')
        el.className = 'user-dot'
        markerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat(lnglat)
          .addTo(map)
      },
      () => setLocError(true),
      { enableHighAccuracy: true, timeout: 10_000 }
    )

    return () => {
      markerRef.current?.remove()
      map.remove()
    }
  }, [])

  // ── Update isochrone fill/line color when mode changes ───────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const color = MODE_COLOR[mode]
    map.setPaintProperty('isochrone-fill', 'fill-color', color)
    map.setPaintProperty('isochrone-line', 'line-color', color)
  }, [mode, mapReady])

  // ── Fetch isochrone ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !location || !map || !TOKEN) return

    let cancelled = false
    setLoading(true)

    const [lng, lat] = location
    const url =
      `https://api.mapbox.com/isochrone/v1/mapbox/${mode}/${lng},${lat}` +
      `?contours_minutes=${minutes}&polygons=true&access_token=${TOKEN}`

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error('API error')
        return r.json()
      })
      .then((data) => {
        if (cancelled) return
        const source = map.getSource('isochrone') as mapboxgl.GeoJSONSource
        source?.setData(data)
      })
      .catch(() => {/* silently ignore — map stays as-is */})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [mapReady, location, mode, minutes])

  // ── No token / map error screens ─────────────────────────────────────────
  if (mapError) {
    return (
      <div style={styles.center}>
        <div style={{ fontSize: 40 }}>⚠️</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Map error</div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', maxWidth: 280, textAlign: 'center', lineHeight: 1.5 }}>
          {mapError}
        </div>
      </div>
    )
  }

  if (!TOKEN) {
    return (
      <div style={styles.center}>
        <div style={{ fontSize: 40 }}>🗺️</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Mapbox token required</div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', maxWidth: 280, textAlign: 'center', lineHeight: 1.5 }}>
          Copy <code style={styles.code}>.env.example</code> to <code style={styles.code}>.env</code> and add your public token
        </div>
        <div style={{ ...styles.code, padding: '10px 16px', marginTop: 4 }}>
          VITE_MAPBOX_TOKEN=pk.eyJ1...
        </div>
      </div>
    )
  }

  const color = MODE_COLOR[mode]

  return (
    <div style={{ height: '100%', position: 'relative' }}>

      {/* Map */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Loading pill */}
      {loading && (
        <div style={{ ...styles.pill, top: 16, left: '50%', transform: 'translateX(-50%)', gap: 8 }}>
          <div className="loading-dot" />
          <span>Calculating…</span>
        </div>
      )}

      {/* Location denied banner */}
      {locError && (
        <div style={styles.banner}>
          Location access denied — enable it to see your area
        </div>
      )}

      {/* Bottom controls */}
      <div style={styles.sheet}>
        <div style={styles.handle} />

        {/* Time */}
        <div style={styles.sectionLabel}>Duration</div>
        <div style={styles.row}>
          {TIMES.map((t) => (
            <button
              key={t}
              onClick={() => setMinutes(t)}
              style={minuteBtn(t === minutes, color)}
            >
              {t}m
            </button>
          ))}
        </div>

        {/* Mode */}
        <div style={{ ...styles.sectionLabel, marginTop: 16 }}>Travel mode</div>
        <div style={styles.row}>
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              style={modeBtn(m.id === mode, MODE_COLOR[m.id])}
            >
              <span>{m.icon}</span>
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Inline styles ────────────────────────────────────────────────────────────

const styles = {
  center: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 14,
    padding: 28,
  },
  code: {
    fontFamily: 'ui-monospace, "SF Mono", monospace',
    fontSize: 13,
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    padding: '2px 7px',
    color: 'rgba(255,255,255,0.6)',
  },
  pill: {
    position: 'absolute' as const,
    background: 'rgba(20,20,37,0.92)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 20,
    padding: '6px 14px',
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    whiteSpace: 'nowrap' as const,
  },
  banner: {
    position: 'absolute' as const,
    top: 16, left: 16, right: 16,
    background: 'rgba(220,38,38,0.15)',
    border: '1px solid rgba(220,38,38,0.3)',
    borderRadius: 12,
    padding: '10px 14px',
    fontSize: 13,
    color: '#fca5a5',
    zIndex: 10,
    textAlign: 'center' as const,
  },
  sheet: {
    position: 'absolute' as const,
    bottom: 0, left: 0, right: 0,
    background: 'rgba(13,13,26,0.97)',
    backdropFilter: 'blur(24px)',
    borderTop: '1px solid rgba(255,255,255,0.07)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: '12px 20px',
    paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
    zIndex: 10,
  },
  handle: {
    width: 36, height: 4,
    background: 'rgba(255,255,255,0.14)',
    borderRadius: 2,
    margin: '0 auto 18px',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700 as const,
    color: 'rgba(255,255,255,0.3)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    marginBottom: 10,
  },
  row: {
    display: 'flex' as const,
    gap: 8,
  },
}

function minuteBtn(active: boolean, color: string): React.CSSProperties {
  return {
    flex: 1,
    padding: '11px 0',
    borderRadius: 14,
    border: `1px solid ${active ? color : 'rgba(255,255,255,0.07)'}`,
    background: active ? `${color}22` : 'rgba(255,255,255,0.03)',
    color: active ? color : 'rgba(255,255,255,0.4)',
    fontSize: 14,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  }
}

function modeBtn(active: boolean, color: string): React.CSSProperties {
  return {
    flex: 1,
    padding: '12px 0',
    borderRadius: 14,
    border: `1px solid ${active ? color : 'rgba(255,255,255,0.07)'}`,
    background: active ? `${color}22` : 'rgba(255,255,255,0.03)',
    color: active ? color : 'rgba(255,255,255,0.4)',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    transition: 'all 0.15s',
  }
}
