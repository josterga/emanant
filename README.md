# Emanant

**Your world, within reach.**

Emanant draws the area you can reach from your current location within a chosen time window and surfaces the neighborhoods and places inside it.

## Features

- **Travel modes:** walking, cycling
- **Durations:** 5, 10, 15, 20, 25, or 30 minutes
- **Reach list:** nearby neighborhood names with cardinal direction, distance, and estimated travel time
- **Spaces:** optional toggle to include parks and public spaces in the reach list
- **Address search:** type any address or place to explore that area remotely
- **Pin drop:** long-press anywhere on the map to drop a pin at that coordinate
- **Live location:** GPS updates as you move
- **Location sharing:** share a URL that opens the app centered on your current isochrone
- **Compass:** optional device-orientation heading indicator
- **Themes:** light, dark, or system
- **Units:** metric or imperial

Settings let you configure appearance, units, compass, spaces visibility, and analytics consent.

## Pin mode

Pin mode lets you explore any neighborhood without being physically there — useful for apartment hunting, trip planning, or curiosity.

Drop a pin via address search or by long-pressing the map. The isochrone regenerates from the pin while your GPS dot stays visible at your actual location. A "Viewing a pinned location" banner at the top of the screen confirms the mode; tapping "Clear pin x" restores your GPS origin instantly.

No addresses are saved or included in shared URLs. Pins are ephemeral.

## Privacy

**Analytics (Google Analytics 4):** Emanant uses GA4 to understand how the app is used (button taps, feature interactions). Analytics are tied to city-level location only. Your precise GPS coordinates are never sent to Google. You can opt out in Settings under Analytics.

**Map data (Mapbox):** Drawing your reachable area requires sending your GPS coordinates to the Mapbox Isochrone API. Mapbox uses this to calculate the reachable polygon. The app does not store, log, or retain that coordinate data.

## License

Emanant is proprietary software. See [LICENSE](LICENSE) for full terms. No part of this codebase may be reproduced or distributed without permission.
