import { useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

const LOCATION_INTERVAL_MS = 10_000
const MOVE_THRESHOLD_M     = 10

// ── Theme tokens ─────────────────────────────────────────────────────────────

function tok(dark: boolean) {
  return dark ? {
    bodyBg:         '#0f0f1a',
    bg:             'rgba(13,13,26,0.97)',
    bgBlur:         'rgba(20,20,37,0.92)',
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
  } : {
    bodyBg:         '#f5f5f0',
    bg:             'rgba(248,248,245,0.97)',
    bgBlur:         'rgba(248,248,245,0.92)',
    text:           'rgba(15,15,25,0.75)',
    textMuted:      'rgba(15,15,25,0.35)',
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

// ── Map layer setup (called on init and after style change) ───────────────────

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
  if (!map.getSource('isochrone')) {
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
  }
}

// ── Mode icons (Material Design paths, currentColor) ─────────────────────────

function WalkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9l1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z"/>
    </svg>
  )
}

function BikeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10l2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6l-2.2-2.5zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
    </svg>
  )
}

function DriveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>
    </svg>
  )
}

const MODE_ICONS: Record<string, () => JSX.Element> = {
  walking: WalkIcon,
  cycling: BikeIcon,
  driving: DriveIcon,
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODES: { id: string; label: string }[] = [
  { id: 'walking', label: 'Walk'  },
  { id: 'cycling', label: 'Bike'  },
  { id: 'driving', label: 'Drive' },
]

const TIMES = [5, 10, 15, 20, 30]

const MODE_COLOR: Record<string, string> = {
  walking: '#FF6B35',
  cycling: '#10B981',
  driving: '#6366F1',
}

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

export default function App() {
  const containerRef      = useRef<HTMLDivElement>(null)
  const mapRef            = useRef<mapboxgl.Map | null>(null)
  const markerRef         = useRef<mapboxgl.Marker | null>(null)
  const lastFetchedRef    = useRef<[number, number] | null>(null)
  const firstFixRef       = useRef(true)
  const lastHeadingRef    = useRef<number | null>(null)

  const [themeMode,  setThemeMode]  = useState<'light' | 'system' | 'dark'>(
    () => (localStorage.getItem('theme') as 'light' | 'system' | 'dark') ?? 'system'
  )
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const dark = themeMode === 'dark' || (themeMode === 'system' && systemDark)

  // Stable ref so the init effect can read the initial style without being in its dep array
  const currentMapStyleRef = useRef(dark ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11')

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

  const t = useMemo(() => tok(dark), [dark])

  // ── System dark mode listener ─────────────────────────────────────────────
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // ── Apply theme to body + CSS custom properties for reach list ────────────
  useEffect(() => {
    document.body.style.background = t.bodyBg
    const r = document.documentElement
    r.style.setProperty('--reach-bg',          t.bgBlur)
    r.style.setProperty('--reach-border',      t.border)
    r.style.setProperty('--reach-item-border', t.borderFaint)
    r.style.setProperty('--reach-text',        t.text)
    r.style.setProperty('--reach-arrow',       t.textMuted)
    r.style.setProperty('--reach-dist',        t.subduedFg)
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
      map.setPaintProperty('isochrone-fill', 'fill-color', MODE_COLOR[mode])
      map.setPaintProperty('isochrone-line', 'line-color', MODE_COLOR[mode])
      setMapReady(true)
    })
    map.setStyle(newStyle)
  }, [t.mapStyle, mapReady, mode])

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

        const isoRadius  = isochroneRadius([lng, lat], isoData)
        const nBoundary  = isoRadius < 2_000 ? 0 : 4
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
  }, [mapReady, location, mode, minutes])

  // ── Compass class + reset ─────────────────────────────────────────────────
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

  function setTheme(mode: 'light' | 'system' | 'dark') {
    setThemeMode(mode)
    localStorage.setItem('theme', mode)
  }

  function toggleUnits() {
    const next = units === 'metric' ? 'imperial' : 'metric'
    setUnits(next)
    localStorage.setItem('units', next)
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
  const S = makeStyles(t)

  return (
    <div style={{ height: '100%', position: 'relative' }}>

      {/* Map */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Top-left: neighborhood pill + reach list */}
      {neighborhood && (
        <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10 }}>
          <div
            onClick={() => reachList.length && setListExpanded(x => !x)}
            style={{ ...S.pill, position: 'relative', cursor: reachList.length ? 'pointer' : 'default', gap: 6 }}
          >
            {neighborhood}
            {reachList.length > 0 && (
              <span style={{ fontSize: 11, opacity: 0.45, display: 'inline-block', transform: listExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                ›
              </span>
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
        <div style={{ ...S.pill, top: 16, right: 16 }}>
          ↑ {toCardinal(heading).cardinal}
        </div>
      )}

      {/* Top-center: loading pill */}
      {loading && (
        <div style={{ ...S.pill, top: 16, left: '50%', transform: 'translateX(-50%)', gap: 8 }}>
          <div className="loading-dot" />
          <span>Calculating…</span>
        </div>
      )}

      {/* Location denied banner */}
      {locError && (
        <div style={S.banner}>
          Location access denied — enable it to see your area
        </div>
      )}

      {/* Bottom sheet */}
      <div style={S.sheet}>

        {/* Handle row with settings gear */}
        <div style={{ position: 'relative', marginBottom: 18 }}>
          <div style={S.handle} />
          <button onClick={() => setSettingsOpen(x => !x)} style={S.gearBtn} aria-label="Settings">⚙</button>
        </div>

        {/* Settings section */}
        {settingsOpen && (
          <div style={S.settingsRow}>
            {/* Appearance */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={S.sectionLabel}>Appearance</span>
              <div style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', border: `1px solid ${t.btnBorder}` }}>
                {(['light', 'system', 'dark'] as const).map((m, i) => (
                  <button
                    key={m}
                    onClick={() => setTheme(m)}
                    style={{
                      padding: '5px 10px',
                      background: themeMode === m ? 'rgba(99,102,241,0.18)' : t.btnBg,
                      border: 'none',
                      borderRight: i < 2 ? `1px solid ${t.btnBorder}` : 'none',
                      color: themeMode === m ? '#818cf8' : t.btnText,
                      fontSize: 12,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {m === 'system' ? 'Auto' : m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Separator */}
            <div style={{ width: 1, height: 20, background: t.borderFaint }} />

            {/* Units */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={S.sectionLabel}>Units</span>
              <button onClick={toggleUnits} style={S.settingsBtn}>
                {units === 'metric' ? 'km' : 'mi'}
              </button>
            </div>

            {/* Separator */}
            <div style={{ width: 1, height: 20, background: t.borderFaint }} />

            {/* Compass */}
            {!compassEnabled
              ? <button onClick={requestCompass} style={S.settingsBtn}>Enable compass</button>
              : <span style={{ fontSize: 12, color: t.subduedFg }}>Compass active</span>
            }
          </div>
        )}

        {/* Duration */}
        <div style={S.sectionLabel}>Duration</div>
        <div style={S.row}>
          {TIMES.map((t_) => (
            <button key={t_} onClick={() => setMinutes(t_)} style={minuteBtn(t_ === minutes, color, t)}>
              {t_}m
            </button>
          ))}
        </div>

        {/* Travel mode */}
        <div style={{ ...S.sectionLabel, marginTop: 16 }}>Travel mode</div>
        <div style={S.row}>
          {MODES.map((m) => {
            const Icon = MODE_ICONS[m.id]
            return (
              <button key={m.id} onClick={() => setMode(m.id)} style={modeBtn(m.id === mode, MODE_COLOR[m.id], t)}>
                <Icon />
                <span>{m.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Styles (theme-aware) ──────────────────────────────────────────────────────

function makeStyles(t: Tok) {
  return {
    pill: {
      position: 'absolute' as const,
      background: t.bgBlur,
      backdropFilter: 'blur(12px)',
      border: `1px solid ${t.border}`,
      borderRadius: 20,
      padding: '6px 14px',
      fontSize: 13,
      color: t.text,
      zIndex: 10,
      display: 'flex',
      alignItems: 'center',
      whiteSpace: 'nowrap' as const,
    },
    banner: {
      position: 'absolute' as const,
      top: 16, left: 16, right: 16,
      background: t.bannerBg,
      border: `1px solid ${t.bannerBorder}`,
      borderRadius: 12,
      padding: '10px 14px',
      fontSize: 13,
      color: t.bannerText,
      zIndex: 10,
      textAlign: 'center' as const,
    },
    sheet: {
      position: 'absolute' as const,
      bottom: 0, left: 0, right: 0,
      background: t.bg,
      backdropFilter: 'blur(24px)',
      borderTop: `1px solid ${t.borderFaint}`,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: '12px 20px',
      paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
      zIndex: 10,
    },
    handle: {
      width: 36, height: 4,
      background: t.handle,
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
      color: t.gearColor,
      fontSize: 18,
      cursor: 'pointer',
      padding: '4px 2px',
      lineHeight: 1,
      fontFamily: 'inherit',
    },
    settingsRow: {
      display: 'flex' as const,
      alignItems: 'center',
      flexWrap: 'wrap' as const,
      gap: 10,
      paddingBottom: 14,
      marginBottom: 14,
      borderBottom: `1px solid ${t.borderSep}`,
    },
    settingsBtn: {
      padding: '5px 12px',
      borderRadius: 10,
      border: `1px solid ${t.btnBorder}`,
      background: t.btnBg,
      color: t.btnText,
      fontSize: 12,
      cursor: 'pointer',
      fontFamily: 'inherit',
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: 700 as const,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.8px',
      marginBottom: 10,
    },
    row: {
      display: 'flex' as const,
      gap: 8,
    },
  }
}

function minuteBtn(active: boolean, color: string, t: Tok): React.CSSProperties {
  return {
    flex: 1,
    padding: '11px 0',
    borderRadius: 14,
    border: `1px solid ${active ? color : t.btnBorder}`,
    background: active ? `${color}22` : t.btnBg,
    color: active ? color : t.btnText,
    fontSize: 14,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  }
}

function modeBtn(active: boolean, color: string, t: Tok): React.CSSProperties {
  return {
    flex: 1,
    padding: '12px 0',
    borderRadius: 14,
    border: `1px solid ${active ? color : t.btnBorder}`,
    background: active ? `${color}22` : t.btnBg,
    color: active ? color : t.btnText,
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
