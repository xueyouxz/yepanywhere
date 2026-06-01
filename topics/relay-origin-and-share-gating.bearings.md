# Relay Origin And Share Gating Bearings

- [*] Public share hosted-link repair
  > why: Public read-only share should be secret-link readable without requiring
  > normal relay login, and the hosted/default route should not trap viewers in
  > the remote-login flow.
  - [x] Reproduce the current public-share link failure.
    > why: User-observed state on 2026-06-01: the public share feature appears
    > broken, with links hardcoded through the `yepanywhere.com` relay and then
    > requiring relay login instead of opening as a public read-only share.
  - [x] Check generated share URL construction against configured Remote Access
        and Public Share Viewer settings.
    > why: The likely fault is in default viewer base URL, relay username/query
    > propagation, or fallback behavior when the hosted viewer cannot make the
    > secret-only public fetch.
  - [x] Normalize configured relay input before it reaches public-share links.
    > why: Operators should be able to type a relay host such as
    > `relay.graehl.org`; public share links need the actual websocket endpoint
    > in `r=` when the relay is not the upstream default.
  - [x] Route `/remote/share/:secret` before authenticated remote-app fallback.
    > why: The current hosted default uses `/remote/share`; if the remote build
    > basename is `/`, that path must still enter `PublicSharePage` rather than
    > the normal relay-login app.
  - [x] Decide the configurable public-share/login URL model.
    > why: Current tactical docs call this route unsettled; fixing the broken
    > link should settle or narrow that contract rather than preserve a hidden
    > hosted-routing dependency.
    The durable model has two operator-controlled URLs: a relay URL normalized
    to `ws(s)://.../ws` and a YA hosted-client URL normalized to
    `http(s)://...`. Public shares append `/share/:secret` to the YA URL; relay
    login links append `/login/relay`. The upstream default remains
    `https://yepanywhere.com/remote`, while this clone can configure
    `https://ya.graehl.org`.
