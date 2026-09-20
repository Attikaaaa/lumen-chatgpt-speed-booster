# Lumen v3.1.0 — Manual Release Checklist

Automated tests cannot prove integration against live, signed-in
chatgpt.com. Work through this list before publishing a release. Nothing
here can be skipped just because CI is green.

## Installation

- [ ] `chrome://extensions` → Developer mode → Load unpacked (this folder)
- [ ] No manifest or service-worker errors on the extension card
- [ ] Open chatgpt.com; reload the page after install/update
- [ ] Extension reload (circular arrow) also works on already-open tabs

## Profiles (use a genuinely long conversation)

- [ ] **Auto**: small chat (≤120 messages) renders fully native; a very long chat shows a limited window
- [ ] **Fast**: ~10 recent messages visible
- [ ] **Balanced**: ~20 recent messages visible
- [ ] **Extreme**: ~5 recent messages visible
- [ ] **Native**: full conversation loads; nothing is hidden
- [ ] **Custom**: set the stepper (e.g. 7) and verify the visible window matches

## Pause

- [ ] Master toggle OFF → exactly one page reload happens
- [ ] The full conversation is back (nothing stays hidden/trimmed)
- [ ] No repeated reload loop
- [ ] Programmatic smooth-scroll behaves natively again (no instant-jump rewriting)
- [ ] Sidebar rows render normally (no content-visibility shortcut)
- [ ] Transitions/backdrop-blur are back (animation toggle no longer applied)
- [ ] Telemetry requests fire again (Network tab: no blocked statsig/sentry calls)

## Resume

- [ ] Master toggle ON → exactly one reload; the chosen profile is active again
- [ ] Status chip in the popup switches Active/Paused correctly

## Progressive history

- [ ] In a long chat, scroll up repeatedly: multiple chunks load (25 msgs each)
- [ ] No message ranges disappear; no duplicates
- [ ] Viewport stays anchored while chunks mount (no jump to top)
- [ ] A conversation with many image/tool (non-text) turns still loads all ranges
- [ ] Reaching the top stops loading (no endless requests)

## Rich archived messages

Check ghost-rendered (older) messages containing:

- [ ] Paragraphs and line breaks
- [ ] **Bold**, *italic*, `inline code`
- [ ] Fenced code blocks (content verbatim, no execution)
- [ ] Lists
- [ ] Links (open in new tab; javascript:/data: links render as plain text)
- [ ] Image / tool / citation turns: these render as simplified text or are
      skipped in the archive — known intentional limitation of the read-only
      ghost renderer (live turns are untouched)

## Branches (critical — graph tests cannot prove live UI compatibility)

- [ ] "Regenerate response" works after trimming
- [ ] Alternate-response switcher (< 1/2 >) works inside the kept window
- [ ] Switching to an alternate stub shows its message
- [ ] Editing an old (trimmed) user message works — ChatGPT rebuilds the branch
- [ ] A branch switcher at the trim boundary does not break the conversation
- [ ] New messages after a branch switch continue normally

## Library

- [ ] Launcher button appears; panel opens/closes
- [ ] Current conversation is captured automatically; + current works
- [ ] Search matches titles
- [ ] Pin/unpin persists across panel close/open and page reload
- [ ] All / ★ Pinned chips filter correctly
- [ ] + folder creates a folder; folder chips filter
- [ ] Hover actions: move-to-folder (create-by-name), delete
- [ ] Bulk: select → Move… / Delete apply to the selection
- [ ] Navigating between chats keeps library data intact
- [ ] Page reload keeps folders/pins (chrome.storage.local)

## Navigation / cache

- [ ] Chat A (long) → Chat B: no archived turns from A appear in B
- [ ] Browser Back/Forward between chats works; windowing follows the visible chat
- [ ] In-app sidebar navigation (SPA) behaves like full navigation

## ChatGPT output (must be unaffected)

- [ ] New responses stream normally (no delay, no duplicated tokens)
- [ ] Stop button works mid-generation
- [ ] Regenerate works
- [ ] Code blocks render and copy
- [ ] Citations / tools / image outputs render in live turns

## Telemetry blocking

- [ ] DevTools Network: statsig / sentry / intercom requests blocked while
      Lumen is enabled AND "Block trackers" is on
- [ ] Toggling "Block trackers" off (while enabled) unblocks them
- [ ] Non-ChatGPT websites are never affected
