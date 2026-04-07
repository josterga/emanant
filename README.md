# Emanant

**Your world, within reach.**

Emanant draws the area you can reach from your current location within a chosen time window and surfaces the neighborhoods and places inside it.

## What it does

Set a travel mode and a duration. Emanant queries the Mapbox Isochrone API, renders the reachable area as a polygon on the map, and lists up to 12 nearby places found within that boundary — each labeled with its direction and distance from you.

- **Travel modes** — walking, cycling, driving
- **Durations** — 5, 10, 15, 20, or 30 minutes
- **Reach list** — nearby place names with cardinal direction and distance
- **Live location** — updates as you move (10-second interval, 10 m threshold)
- **Compass** — optional device-orientation heading indicator
- **Themes** — light, dark, or system
- **Units** — metric or imperial

## Stack

| | |
|---|---|
| Framework | React 18 |
| Map | Mapbox GL JS v3 |
| Build | Vite + TypeScript |
| APIs | Mapbox Isochrone, Mapbox Tile Query |

## Getting started

**1. Get a Mapbox token**

Create a free account at [mapbox.com](https://mapbox.com) and copy your public token.

**2. Set the token**

Create a `.env` file in the project root:

```
VITE_MAPBOX_TOKEN=pk.your_token_here
```

**3. Install and run**

```sh
npm install
npm run dev
```

**4. Build for production**

```sh
npm run build
```

## Project structure

```
src/
  App.tsx       # entire application — map init, isochrone fetch, UI
  index.css     # global styles and reach-list component styles
index.html
```

## How it works

1. On load the map centers on your GPS position (or London as a fallback).
2. When location, mode, or duration changes, Emanant fetches an isochrone polygon from the Mapbox API.
3. The polygon is rendered as a semi-transparent fill with a colored outline, and the map zooms to fit it.
4. The Mapbox Tile Query API is called at the center and up to 4 boundary sample points to find `place_label` features inside the polygon.
5. Results are filtered, deduplicated, sorted by distance, and shown in a collapsible list.
