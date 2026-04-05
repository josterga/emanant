import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

const LOCATION_INTERVAL_MS = 10_000 // poll GPS every 10 seconds
const MOVE_THRESHOLD_M = 10        // only refetch isochrone after 10m movement (above GPS noise floor)

function metersApart(a: [number, number], b: [number, number]): number {
  const R = 6_371_000
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  return Math.sqrt(dLat * dLat + dLng * dLng) * R
}

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
  const containerRef    = useRef<HTMLDivElement>(null)
  const mapRef          = useRef<mapboxgl.Map | null>(null)
  const markerRef       = useRef<mapboxgl.Marker | null>(null)
  const lastFetchedRef  = useRef<[number, number] | null>(null)

  const [mapReady,  setMapReady]  = useState(false)
  const [location,  setLocation]  = useState<[number, number] | null>(null)
  const [mode,      setMode]      = useState('walking')
  const [minutes,   setMinutes]   = useState(10)
  const [loading,      setLoading]      = useState(false)
  const [locError,     setLocError]     = useState(false)
  const [neighborhood, setNeighborhood] = useState<string | null>(null)

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

    map.on('load', () => {
      // Terrain DEM — gives hillshade context for why the isochrone
      // boundary falls where it does (especially for walk/cycle modes)
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
        paint: {
          'hillshade-exaggeration': 0.3,
        },
      })

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

    // Poll GPS every LOCATION_INTERVAL_MS; updates marker always, isochrone only after MOVE_THRESHOLD_M
    let firstFix = true

    function handlePosition({ coords }: GeolocationPosition) {
      const lnglat: [number, number] = [coords.longitude, coords.latitude]

      // Always update marker position
      if (markerRef.current) {
        markerRef.current.setLngLat(lnglat)
      } else {
        const el = document.createElement('div')
        el.className = 'user-dot'
        markerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat(lnglat)
          .addTo(map)
      }

      // Fly to location and reverse-geocode neighborhood on first fix only
      if (firstFix) {
        firstFix = false
        map.flyTo({ center: lnglat, zoom: 14, duration: 1000 })
        fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lnglat[0]},${lnglat[1]}.json` +
          `?types=neighborhood,locality,place&access_token=${TOKEN}`
        )
          .then(r => r.json())
          .then(data => {
            const name: string | undefined = data.features?.[0]?.text
            if (name) setNeighborhood(name)
          })
          .catch(() => {/* silently ignore */})
      }

      // Only update location state (triggers isochrone refetch) if moved enough
      const last = lastFetchedRef.current
      if (!last || metersApart(last, lnglat) >= MOVE_THRESHOLD_M) {
        lastFetchedRef.current = lnglat
        setLocation(lnglat)
      }
    }

    const geoOpts: PositionOptions = { enableHighAccuracy: true, timeout: 10_000 }

    // Immediate first fix, then poll on interval
    navigator.geolocation.getCurrentPosition(handlePosition, () => setLocError(true), geoOpts)
    const intervalId = setInterval(
      () => navigator.geolocation.getCurrentPosition(handlePosition, () => {/* keep last known */}, geoOpts),
      LOCATION_INTERVAL_MS
    )

    return () => {
      clearInterval(intervalId)
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

  // ── No token screen ───────────────────────────────────────────────────────
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

      {/* Neighborhood label */}
      {neighborhood && (
        <div style={{ ...styles.pill, top: 16, left: 16 }}>
          {neighborhood}
        </div>
      )}

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
