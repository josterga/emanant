import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

const LOCATION_INTERVAL_MS = 10_000
const MOVE_THRESHOLD_M     = 10

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

// Returns the max vertex distance from center — used to size each per-sample Tilequery radius.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isochroneRadius(center: [number, number], isoData: any): number {
  const ring: [number, number][] = isoData?.features?.[0]?.geometry?.coordinates?.[0] ?? []
  let max = 0
  for (const v of ring) max = Math.max(max, metersApart(center, v as [number, number]))
  return Math.min(Math.ceil(max * 1.1), 50_000)
}

// Returns [center, ...N evenly-spaced boundary points] for parallel Tilequery coverage.
// Walking (small isochrone): centre alone covers everything.
// Cycling/driving: boundary points pick up outer neighbourhoods the centre query misses.
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
  const ring = rings[0] // outer ring only
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
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

// ── Constants ────────────────────────────────────────────────────────────────

const MODES: { id: string; label: string; icon: string }[] = [
  { id: 'walking', label: 'Walk',  icon: '🚶' },
  { id: 'cycling', label: 'Bike',  icon: '🚴' },
  { id: 'driving', label: 'Drive', icon: '🚗' },
]

const TIMES = [5, 10, 15, 20, 30]

const MODE_COLOR: Record<string, string> = {
  walking: '#FF6B35',
  cycling: '#10B981',
  driving: '#6366F1',
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ReachNeighborhood {
  name: string
  bearing: number
  cardinal: string
  arrow: string
  distanceM: number
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const containerRef   = useRef<HTMLDivElement>(null)
  const mapRef         = useRef<mapboxgl.Map | null>(null)
  const markerRef      = useRef<mapboxgl.Marker | null>(null)
  const lastFetchedRef = useRef<[number, number] | null>(null)
  const firstFixRef    = useRef(true)
  const lastHeadingRef = useRef<number | null>(null)

  const [mapReady,       setMapReady]       = useState(false)
  const [location,       setLocation]       = useState<[number, number] | null>(null)
  const [mode,           setMode]           = useState('walking')
  const [minutes,        setMinutes]        = useState(10)
  const [loading,        setLoading]        = useState(false)
  const [locError,       setLocError]       = useState(false)
  const [neighborhood,   setNeighborhood]   = useState<string | null>(null)
  const [reachList,      setReachList]      = useState<ReachNeighborhood[]>([])
  const [listExpanded,   setListExpanded]   = useState(false)
  const [heading,        setHeading]        = useState<number | null>(null)
  const [compassEnabled, setCompassEnabled] = useState(false)
  const [settingsOpen,   setSettingsOpen]   = useState(false)
  const [units,          setUnits]          = useState<'metric' | 'imperial'>(
    () => (localStorage.getItem('units') as 'metric' | 'imperial') ?? 'metric'
  )

  // ── Init map + GPS polling ────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !TOKEN) return

    mapboxgl.accessToken = TOKEN

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      zoom: 13,
      center: [-0.1276, 51.5074],
      antialias: true,
    })
    mapRef.current = map

    map.on('load', () => {
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
      map.addSource('isochrone', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'isochrone-fill',
        type: 'fill',
        source: 'isochrone',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.14 },
      })
      map.addLayer({
        id: 'isochrone-line',
        type: 'line',
        source: 'isochrone',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.7 },
      })
      setMapReady(true)
    })

    function handlePosition({ coords }: GeolocationPosition) {
      const lnglat: [number, number] = [coords.longitude, coords.latitude]

      if (markerRef.current) {
        markerRef.current.setLngLat(lnglat)
      } else {
        const el = document.createElement('div')
        el.className = 'user-dot'
        markerRef.current = new mapboxgl.Marker({ element: el })
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
            const name: string | undefined = data.features?.[0]?.text
            if (name) setNeighborhood(name)
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
    if (!mapReady || !location || !map || !TOKEN) return

    let cancelled = false
    setLoading(true)
    setReachList([])

    const [lng, lat] = location
    const isoUrl =
      `https://api.mapbox.com/isochrone/v1/mapbox/${mode}/${lng},${lat}` +
      `?contours_minutes=${minutes}&polygons=true&access_token=${TOKEN}`

    fetch(isoUrl)
      .then(r => { if (!r.ok) throw new Error('iso'); return r.json() })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((isoData: any) => {
        if (cancelled) return
        ;(map.getSource('isochrone') as mapboxgl.GeoJSONSource)?.setData(isoData)

        // For large isochrones (cycling/driving) the Tilequery limit=50 from a single
        // centre point misses outer neighbourhoods. Sample the polygon boundary at
        // evenly-spaced intervals and run parallel queries; each covers a local radius
        // sized so adjacent queries overlap.
        const isoRadius  = isochroneRadius([lng, lat], isoData)
        const nBoundary  = isoRadius < 2_000 ? 0 : 4   // walk: 1 query; cycling+: 5 queries
        const samples    = isoSamplePoints([lng, lat], isoData, nBoundary)
        const queryRadius = Math.min(Math.ceil(isoRadius * 0.7), 10_000)

        const tqRequests = samples.map(([qLng, qLat]) =>
          fetch(
            `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${qLng},${qLat}.json` +
            `?radius=${queryRadius}&limit=50&layers=place_label&access_token=${TOKEN}`
          ).then(r => r.ok ? r.json() : { features: [] })
        )

        return Promise.all(tqRequests).then(responses => {
          if (cancelled) return
          const isoGeom = isoData.features?.[0]?.geometry

          const EXCLUDE_TYPES = new Set(['country', 'state', 'region', 'country_subdivision', 'city'])
          const REACH_CAP = 12

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const allFeatures = responses.flatMap((r: any) => r.features ?? [])

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hits: ReachNeighborhood[] = allFeatures
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((f: any) => {
              const t: string = f.properties?.type ?? f.properties?.class ?? ''
              return !EXCLUDE_TYPES.has(t)
            })
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

          // Deduplicate by name (same label can appear across multiple zoom-level tiles)
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
  }, [mapReady, location, mode, minutes])

  // ── Device orientation (compass) ──────────────────────────────────────────
  useEffect(() => {
    const el = markerRef.current?.getElement()
    if (!el) return
    el.classList.toggle('user-dot--has-compass', compassEnabled)
    if (!compassEnabled) {
      markerRef.current?.setRotation(0)
      setHeading(null)
      lastHeadingRef.current = null
    }
  }, [compassEnabled])

  useEffect(() => {
    if (!compassEnabled) return

    function handleOrientation(e: DeviceOrientationEvent) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = e as any
      let h: number | null = null
      if (typeof ev.webkitCompassHeading === 'number') {
        h = ev.webkitCompassHeading
      } else if (e.absolute && typeof e.alpha === 'number') {
        h = (360 - e.alpha) % 360
      }
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

  // ── iOS compass permission (must be called from user gesture) ─────────────
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

  function toggleUnits() {
    const next = units === 'metric' ? 'imperial' : 'metric'
    setUnits(next)
    localStorage.setItem('units', next)
  }

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

      {/* Top-left: neighborhood pill + reach list */}
      {neighborhood && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10 }}>
          <div
            onClick={() => reachList.length && setListExpanded(x => !x)}
            style={{
              ...styles.pill,
              position: 'relative',
              cursor: reachList.length ? 'pointer' : 'default',
              gap: 6,
            }}
          >
            {neighborhood}
            {reachList.length > 0 && (
              <span style={{
                fontSize: 11,
                opacity: 0.45,
                display: 'inline-block',
                transform: listExpanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.2s',
              }}>›</span>
            )}
          </div>

          {listExpanded && reachList.length > 0 && (
            <div className="reach-list">
              {reachList.map(item => (
                <div key={item.name} className="reach-item">
                  <span className="reach-arrow">{item.arrow} {item.cardinal}</span>
                  <span className="reach-name">{item.name}</span>
                  <span className="reach-dist">{formatDistance(item.distanceM, units)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Top-right: compass heading */}
      {compassEnabled && heading !== null && (
        <div style={{ ...styles.pill, top: 16, right: 16 }}>
          ↑ {toCardinal(heading).cardinal}
        </div>
      )}

      {/* Top-center: loading pill */}
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

      {/* Bottom sheet */}
      <div style={styles.sheet}>

        {/* Handle row with settings gear */}
        <div style={{ position: 'relative', marginBottom: 18 }}>
          <div style={styles.handle} />
          <button
            onClick={() => setSettingsOpen(x => !x)}
            style={styles.gearBtn}
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>

        {/* Settings section */}
        {settingsOpen && (
          <div style={styles.settingsRow}>
            <span style={styles.sectionLabel}>Units</span>
            <button onClick={toggleUnits} style={styles.settingsBtn}>
              {units === 'metric' ? 'km' : 'mi'}
            </button>
            <div style={{ marginLeft: 'auto' }}>
              {!compassEnabled ? (
                <button onClick={requestCompass} style={styles.settingsBtn}>
                  Enable compass
                </button>
              ) : (
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
                  Compass active
                </span>
              )}
            </div>
          </div>
        )}

        {/* Duration */}
        <div style={styles.sectionLabel}>Duration</div>
        <div style={styles.row}>
          {TIMES.map((t) => (
            <button key={t} onClick={() => setMinutes(t)} style={minuteBtn(t === minutes, color)}>
              {t}m
            </button>
          ))}
        </div>

        {/* Travel mode */}
        <div style={{ ...styles.sectionLabel, marginTop: 16 }}>Travel mode</div>
        <div style={styles.row}>
          {MODES.map((m) => (
            <button key={m.id} onClick={() => setMode(m.id)} style={modeBtn(m.id === mode, MODE_COLOR[m.id])}>
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
    margin: '0 auto',
  },
  gearBtn: {
    position: 'absolute' as const,
    right: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.3)',
    fontSize: 18,
    cursor: 'pointer',
    padding: '4px 2px',
    lineHeight: 1,
    fontFamily: 'inherit',
  },
  settingsRow: {
    display: 'flex' as const,
    alignItems: 'center',
    gap: 12,
    paddingBottom: 14,
    marginBottom: 14,
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  settingsBtn: {
    padding: '5px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
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
