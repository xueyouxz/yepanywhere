# Mobile Companion App

## Status

Concept note. This records the product and architecture direction for a native
mobile companion app. It is not yet an implementation plan.

## Motivation

Yep Anywhere already supports browser push notifications through Web Push/VAPID,
but mobile browser delivery can be delayed when the device is locked, idle, or in
a pocket. For time-sensitive agent events such as pending input or task
completion, the desired user experience is closer to a native messaging app:
install, pair, grant notification permission, and receive reliable alerts without
thinking about browser power-management behavior.

The companion app should also provide a small mobile surface for checking agent
activity across one or more YA servers without reimplementing the full web UI.

## Default User Journey

The primary path should optimize for users who do not want to understand mobile
push infrastructure.

1. Install the YA desktop/server app.
2. Install the YA mobile app.
3. Click "Pair mobile device" on desktop.
4. Scan a QR code or open a pairing link on the phone.
5. Grant notification permission.
6. Receive native mobile notifications and see a minimal activity dashboard.

Source builds and `adb install` should remain possible for advanced users, but
they are not the product-defining path.

## Product Shape

The app is a lightweight native companion, not a replacement YA client.

Core surfaces:

- Pairing and device status.
- Native notifications for pending input, task completion, halted sessions, and
  similar user-visible events.
- A minimal inbox/activity dashboard.
- Aggregation across multiple paired YA servers.
- Shortcuts that deep-link into the full YA web app for detailed work.
- Optional foreground-service mode on Android for users who explicitly want a
  persistent activity subscriber.

The app should feel like a companion device, not like a second place where the
entire YA interface must be learned.

## Non-Goals

- Do not reimplement the full YA web UI in native mobile screens.
- Do not require a WebView for the main product value.
- Do not route all YA traffic through the phone by default.
- Do not require users to create Firebase, APNs, or other push infrastructure.
- Do not make Android foreground service behavior mandatory or always on.
- Do not make localhost or local-network bridging part of the core data path
  unless a concrete benefit justifies the added auth and proxy surface.

## Hosted Push Model

For the published app, YA should own one mobile app identity and one hosted push
path. The normal model is not "each relay owns an FCM project". It is:

- The published Android app belongs to the YA Firebase project.
- The app obtains an FCM registration token.
- The app pairs with a YA server and registers its push route with a YA-hosted
  push broker.
- A YA server sends a small push intent to the broker when a paired device should
  be notified.
- The broker sends a high-priority FCM message to the Android device.
- The app displays a notification or wakes briefly and fetches details from the
  paired YA server.

The push broker can live beside the hosted relay initially, or inside the same
deployment if that is simpler operationally. Conceptually, it should remain a
separate responsibility from the relay: the relay is encrypted transport, while
the broker is a token registry and notification dispatcher.

Payloads should be generic by default. Rich notification text can be added later
only if it is encrypted to a mobile-device key or otherwise fits YA's privacy
model.

## Pairing Model

Pairing should establish a durable relationship between one mobile app install
and one YA server identity.

Likely pairing data:

- Server identity and display name.
- Relay or direct connection route.
- Mobile device id and display name.
- Broker registration id.
- Mobile app public key for encrypted notification payloads or event handoff.
- Revocation metadata so a server can forget a phone and a phone can forget a
  server.

The pairing flow should be driven by QR code or deep link. Manual entry can
exist, but it should not be the common path.

## Multi-Server Inbox

The dashboard should be modeled as an aggregated version of the YA inbox.

Each paired server contributes a small activity feed:

- Sessions needing input.
- Recently completed tasks.
- Halted or failed sessions.
- Recent active agents.
- Connection and freshness state.

The app should preserve server boundaries in the UI. Aggregation is for scanning
and triage, not for hiding which machine owns a session. Opening a detailed item
should deep-link to the corresponding YA web app route.

This aligns with the existing multi-host direction in
`docs/project/multi-host-plan.md`.

## Android-First Capabilities

Android is the first target because it enables the behavior that motivated this
idea:

- FCM high-priority native push for time-sensitive notifications.
- A foreground service for explicitly enabled persistent activity subscription.
- Optional localhost or local-network endpoints for detection, pairing, or
  page-open/event handoff.
- A native dashboard without relying on browser service-worker delivery.

Foreground service mode should be default-off and clearly user controlled. It is
useful for "keep activity live" behavior, but it carries battery and notification
surface costs.

Localhost integration should be treated as an auxiliary channel only. Reasonable
uses include detection, pairing, and a page-open/event handoff between the web
app and the native app. Routing all YA traffic through it should wait for a
specific, measured benefit.

## iOS Compatibility

The core companion concept is compatible with a future iOS app:

- Native push notifications.
- Pairing and server status.
- Aggregated inbox/dashboard.
- Deep links into the web app.

The Android foreground-service activity subscriber is not portable to iOS in the
same form. A future iOS implementation would likely rely on APNs-backed push,
background refresh where available, and foreground app activity rather than a
persistent background service.

To keep that path open, shared backend concepts should be platform-neutral:

- Device registration.
- Pairing records.
- Push intents.
- Inbox snapshots.
- Event freshness and acknowledgement metadata.

Platform-specific delivery details can live below that shared model.

## Self-Hosted and Source Builds

The primary product should assume the published YA app and YA-hosted broker.
Advanced paths can be supported later:

- Build from source and install with `adb`.
- Use the standard YA-hosted broker with a source-built compatible app.
- Bring a custom FCM project/service account for a fully independent build.
- Run without broker push and rely only on foreground-service subscription.

These should be documented as advanced modes. They should not be required for
the normal desktop-plus-phone setup.

## Security and Privacy Notes

The broker should not become a transcript service.

Default broker-visible data should be limited to routing and delivery metadata:

- Mobile registration tokens.
- Device/server association ids.
- Push intent type.
- Timing and delivery attempts.

The phone should fetch sensitive details from the paired YA server over the
normal authenticated/encrypted path. If rich notification content is needed
while the app is not connected, encrypt that content for the paired mobile
device rather than making the broker trusted with plaintext.

Revocation must be first-class:

- Server can remove a mobile device.
- Mobile app can forget a server.
- Broker tokens can be invalidated or rotated.
- Lost phones should be removable from the desktop/server UI.

## Open Questions

- Should the first app be native Android, Kotlin Multiplatform, React Native, or
  another shared mobile stack?
- Should the broker live inside the relay service process at first, or as a
  separate service from the beginning?
- What is the smallest inbox snapshot API that supports useful aggregation
  without pulling in the full web app session model?
- Should notification acknowledgement be recorded by the app, the server, the
  broker, or all three?
- How much local page-open/event handoff is worth building before there is a
  concrete use case?
- What is the minimum source-build story that is acceptable without making it
  look like the supported mainstream path?
