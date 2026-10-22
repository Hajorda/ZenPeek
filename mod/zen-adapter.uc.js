// Zen Peek — every call into Zen/Firefox internals lives here.
// Checked against zen-browser/desktop @ 13d57d0 (2026-09-29).
//
// Internals relied on:
//   tab[zen-essential], tab.pinned, tab._zenPinnedInitialState.entry.url,
//   gBrowser.{tabContainer, selectedTab, selectedBrowser, getIcon},
//   browsingContext.currentWindowGlobal.drawSnapshot (as Zen's Glance uses it),
//   gZenVerticalTabsManager._prefsRightSide (which side the panel opens on), #navigator-toolbox (the sidebar),
//   gZenWorkspaces.{promiseInitialized, privateWindowOrDisabled}, #tabContextMenu, TabContextMenu.contextTab,
//   openTrustedLinkIn, Services.focus.activeWindow,
//   #navigator-toolbox[has-popup-menu] (compact mode keeps the sidebar out while it's set),
//   tab events: TabAttrModified, TabOpen, TabClose, TabPinned, TabUnpinned,
//   TabAddedToEssentials, TabRemovedFromEssentials (Zen), and the tab's .tab-stack (badge CSS)
/* exported ZPZen */
// eslint-disable-next-line no-var
var ZPZen = (() => {
  "use strict";
  const HTML = "http://www.w3.org/1999/xhtml";
  let panel = null;
  let panelStyle = null;
  let resizeObserver = null;
  let followFrame = 0;
  let onAnchorLost = null;
  let lastPlacement = null;
  let heldSidebar = null; // the sidebar we're keeping out (compact mode), if any

  return {
    get supported() {
      return typeof gZenWorkspaces !== "undefined" && !gZenWorkspaces.privateWindowOrDisabled;
    },

    async whenReady() {
      await window.delayedStartupPromise;
      await gZenWorkspaces.promiseInitialized;
    },

    // Calls enter(tab)/leave(tab) as the pointer moves over Essentials
    // (and pinned tabs, if `includePinned()` says so).
    watchHover({ enter, leave, includePinned }) {
      const match = (el) => {
        const tab = el?.closest?.("tab");
        if (!tab || !gBrowser.isTab(tab)) return null;
        if (tab.hasAttribute("zen-essential")) return tab;
        return includePinned() && tab.pinned && !tab.hasAttribute("zen-empty-tab") ? tab : null;
      };
      let current = null;
      const over = (e) => {
        const tab = match(e.target);
        if (tab === current) return;
        if (current) leave(current);
        current = tab;
        if (tab) enter(tab);
      };
      const out = (e) => {
        if (current && !current.contains(e.relatedTarget)) {
          leave(current);
          current = null;
        }
      };
      const root = gBrowser.tabContainer.closest("#navigator-toolbox") || document.documentElement;
      root.addEventListener("mouseover", over);
      root.addEventListener("mouseout", out);
      return () => {
        root.removeEventListener("mouseover", over);
        root.removeEventListener("mouseout", out);
      };
    },

    // Essentials (and pinned tabs, if asked), in sidebar order, across workspaces.
    essentials(includePinned = false) {
      return [...gBrowser.tabs].filter((t) =>
        t.hasAttribute("zen-essential") || (includePinned && t.pinned && !t.hasAttribute("zen-empty-tab")));
    },

    // Calls `onChange()` when tabs change in ways that can affect badges
    // (title, loaded state, pinned/Essential state, opened/closed).
    watchTabs(onChange) {
      const container = gBrowser.tabContainer;
      const attr = (e) => {
        const changed = e.detail?.changed || [];
        if (changed.some((c) => c === "label" || c === "pending" || c === "busy" || c === "zen-essential")) onChange(e.target);
      };
      const any = (e) => onChange(e.target);
      const events = ["TabOpen", "TabClose", "TabPinned", "TabUnpinned"];
      container.addEventListener("TabAttrModified", attr);
      for (const ev of events) container.addEventListener(ev, any);
      // Zen dispatches these on the tab; they bubble to the window.
      window.addEventListener("TabAddedToEssentials", any);
      window.addEventListener("TabRemovedFromEssentials", any);
      return () => {
        container.removeEventListener("TabAttrModified", attr);
        for (const ev of events) container.removeEventListener(ev, any);
        window.removeEventListener("TabAddedToEssentials", any);
        window.removeEventListener("TabRemovedFromEssentials", any);
      };
    },

    // Unread badge on a tab's icon: "3", "99+", "" (a dot) or null (none).
    // Drawn by CSS from the attribute; `label` is read out by screen readers.
    setBadge(tab, text, label = "") {
      if (text === null || text === undefined) {
        if (tab.hasAttribute("zen-peek-badge")) {
          tab.removeAttribute("zen-peek-badge");
          tab.removeAttribute("aria-description");
          tab.style.removeProperty("--zen-peek-badge");
        }
        return;
      }
      if (tab.getAttribute("zen-peek-badge") !== text) {
        tab.setAttribute("zen-peek-badge", text);
        tab.style.setProperty("--zen-peek-badge", JSON.stringify(text)); // a CSS string: "3"
      }
      if (label) tab.setAttribute("aria-description", label);
    },

    // Is this the window the user is working in?
    windowActive() {
      try {
        return Services.focus.activeWindow === window;
      } catch {
        return document.hasFocus();
      }
    },

    // Pointer position in the window, for the "moving toward the preview" check.
    onPointerMove(fn) {
      const move = (e) => fn({ x: e.clientX, y: e.clientY });
      window.addEventListener("mousemove", move, { passive: true, capture: true });
      return () => window.removeEventListener("mousemove", move, { capture: true });
    },

    // The tab that has keyboard focus in the sidebar, or the selected tab.
    focusedTab() {
      const el = document.activeElement;
      const tab = el?.closest?.("tab");
      return tab && gBrowser.isTab(tab) ? tab : gBrowser.selectedTab;
    },

    tabUrl(tab) {
      return tab._zenPinnedInitialState?.entry?.url || tab.linkedBrowser?.currentURI?.spec || "";
    },
    tabTitle: (tab) => tab.label || "",
    tabIcon: (tab) => gBrowser.getIcon(tab) || "",
    isLoaded: (tab) => !!tab.linkedPanel && !tab.hasAttribute("pending"),

    // A picture of a loaded tab's page, as a canvas `width` px wide (or null).
    async snapshot(tab, width) {
      try {
        const browser = tab.linkedBrowser;
        const wg = browser?.browsingContext?.currentWindowGlobal;
        if (!wg) return null;
        const w = browser.clientWidth || gBrowser.selectedBrowser.clientWidth || 1200;
        const h = browser.clientHeight || gBrowser.selectedBrowser.clientHeight || 800;
        const scale = width / w;
        const bitmap = await wg.drawSnapshot(new DOMRect(0, 0, w, Math.min(h, w * 0.65)), scale, "white");
        const canvas = document.createElementNS(HTML, "canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        bitmap.close?.();
        return canvas;
      } catch (e) {
        console.warn("Zen Peek: snapshot failed", e);
        return null;
      }
    },

    // --- Preview panel -----------------------------------------------------------
    // Both styles are drawn inside Zen's own window (no native popup window), so
    // they open instantly and are always placed from the Essential's live position.
    //  "card"  — floats beside the sidebar and glides between Essentials.
    //  "popup" — the classic look: an arrow points at the hovered Essential; it
    //            switches instantly, follows the Essential if the sidebar moves,
    //            and closes if the Essential disappears.
    panel({ onEnter, onLeave, onLost, onFocusOut, style = "card" }) {
      if (panel && panelStyle === style) return panel;
      this.removePanel();
      // Remove a panel left by an older copy (after an update without restart).
      // Older versions used a native <panel>, so close it first.
      for (const old of document.querySelectorAll("#zen-peek-panel")) {
        try {
          old.hidePopup?.();
        } catch { /* not a popup */ }
        old.remove();
      }
      const root = document.createElementNS(HTML, "div");
      root.id = "zen-peek-root";
      panel = document.createElementNS(HTML, "div");
      panel.id = "zen-peek-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("tabindex", "-1");
      panel.className = style === "popup" ? "zp-card zp-classic" : "zp-card";
      panel.append(root);
      if (style === "popup") {
        const arrow = document.createElementNS(HTML, "div");
        arrow.className = "zp-arrow";
        panel.append(arrow);
      }
      document.documentElement.append(panel);
      panelStyle = style;
      onAnchorLost = onLost || null;
      panel.addEventListener("mouseenter", onEnter);
      panel.addEventListener("mouseleave", onLeave);
      // Keyboard: focus moving out of the preview (e.g. a click elsewhere).
      panel.addEventListener("focusout", (e) => {
        if (!panel?.contains(e.relatedTarget)) onFocusOut?.();
      });
      // Keep it on screen when its content grows or shrinks.
      resizeObserver = new ResizeObserver(() => this.reposition());
      resizeObserver.observe(root);
      return panel;
    },

    panelRoot: () => panel?.querySelector("#zen-peek-root"),
    panelElement: () => panel,
    panelRect: () => (panel && panel.classList.contains("zp-open") ? panel.getBoundingClientRect() : null),
    // Name read out by screen readers ("Preview: Gmail").
    setPanelLabel(text) {
      panel?.setAttribute("aria-label", text);
    },
    // Keyboard: the panel's focusable rows and buttons, in order.
    panelFocusables: () => [...(panel?.querySelectorAll("[tabindex='0'], button") || [])],
    panelHasFocus: () => !!panel && panel.contains(document.activeElement),
    panelOpen: () => !!panel?.classList.contains("zp-open"),
    get panelStyle() {
      return panelStyle;
    },
    // Where the panel was last placed and why (for diagnostics).
    get lastPlacement() {
      return lastPlacement;
    },

    // Is the Essential actually on screen? A hidden, collapsed or off-screen
    // anchor would give a meaningless position, so the classic style won't open there.
    anchorUsable(a) {
      if (!a?.isConnected) return false;
      const r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return false;
      try {
        if (a.checkVisibility && !a.checkVisibility({ visibilityProperty: true })) return false;
      } catch { /* older engine: rect checks above are enough */ }
      return true;
    },

    // Place the panel beside the sidebar, kept inside the window.
    reposition() {
      if (!panel || !this._anchor || !this.panelOpen()) return null;
      const r = this._anchor.getBoundingClientRect();
      const w = panel.offsetWidth || 320;
      const h = panel.offsetHeight || 120;
      const gap = 8;
      const right = !!gZenVerticalTabsManager?._prefsRightSide;
      // Open outside the sidebar, so the panel never covers other Essentials.
      const sidebar = document.getElementById("navigator-toolbox");
      const edge = sidebar?.contains(this._anchor) ? sidebar.getBoundingClientRect() : r;
      let x, y;
      let arrowY = null;
      if (panelStyle === "popup") {
        // Classic: the arrow (11px) sits between the sidebar and the panel and
        // points at the middle of the Essential.
        const ARROW_GAP = 16;
        const centerY = r.top + r.height / 2;
        x = right ? edge.left - w - ARROW_GAP : edge.right + ARROW_GAP;
        y = centerY - 24;
      } else {
        x = right ? edge.left - w - gap : edge.right + gap;
        y = r.top - 6;
      }
      const wantX = x;
      const wantY = y;
      x = Math.max(gap, Math.min(x, window.innerWidth - w - gap));
      y = Math.max(gap, Math.min(y, window.innerHeight - h - gap));
      if (panelStyle === "popup") {
        arrowY = Math.max(16, Math.min(r.top + r.height / 2 - y, h - 16));
        panel.style.setProperty("--zp-arrow-y", `${Math.round(arrowY)}px`);
        panel.setAttribute("zp-side", right ? "right" : "left");
      }
      panel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      const box = (b) => ({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
      lastPlacement = {
        style: panelStyle,
        side: right ? "right" : "left",
        anchor: box(r),
        sidebar: sidebar?.contains(this._anchor) ? box(edge) : null,
        panel: { x: Math.round(x), y: Math.round(y), w, h },
        clamped: Math.round(wantX) !== Math.round(x) || Math.round(wantY) !== Math.round(y),
        arrowY: arrowY === null ? null : Math.round(arrowY),
        window: { w: window.innerWidth, h: window.innerHeight },
      };
      return lastPlacement;
    },

    // Compact mode hides the sidebar as soon as the mouse leaves it, which would
    // pull the Essential (and the preview's reason to exist) away while you move
    // to the preview. Zen keeps the sidebar out while one of its menus is open
    // ([has-popup-menu]); the preview does the same while it's open. Only an
    // attribute we added is ever removed.
    keepSidebarOpen(anchor) {
      const sidebar = document.getElementById("navigator-toolbox");
      const want = !!anchor && !!sidebar?.contains(anchor);
      if (want && heldSidebar !== sidebar) {
        this.releaseSidebar();
        if (!sidebar.hasAttribute("has-popup-menu")) {
          sidebar.setAttribute("has-popup-menu", "true");
          heldSidebar = sidebar;
        }
      } else if (!want) {
        this.releaseSidebar();
      }
    },
    releaseSidebar() {
      heldSidebar?.removeAttribute("has-popup-menu");
      heldSidebar = null;
    },

    // Returns false if it couldn't open (classic: the Essential isn't visible).
    openPanel(anchor) {
      const opened = this._openPanel(anchor);
      if (opened) this.keepSidebarOpen(anchor);
      return opened;
    },
    _openPanel(anchor) {
      if (panelStyle === "popup") {
        if (!this.anchorUsable(anchor)) {
          this.closePanel();
          return false;
        }
        this._anchor = anchor;
        panel.classList.add("zp-open"); // fades in; position is set in the same frame
        this.reposition();
        this._follow();
        return true;
      }
      this._anchor = anchor;
      if (this.panelOpen()) {
        this.reposition(); // already visible: glide to the new Essential
        return true;
      }
      // First show: jump into place without the glide, then fade in.
      panel.classList.add("zp-instant", "zp-open");
      this.reposition();
      panel.getBoundingClientRect();
      panel.classList.remove("zp-instant");
      return true;
    },

    // Classic only: while open, keep the panel next to its Essential (the
    // sidebar may still be sliding or resizing) and close it if the Essential
    // disappears. One cheap rect read per frame, only while open.
    _follow() {
      if (followFrame) return;
      let lastKey = "";
      const tick = () => {
        followFrame = 0;
        if (panelStyle !== "popup" || !this.panelOpen() || !this._anchor) return;
        if (!this.anchorUsable(this._anchor)) {
          this.closePanel();
          onAnchorLost?.();
          return;
        }
        const r = this._anchor.getBoundingClientRect();
        const e = document.getElementById("navigator-toolbox")?.getBoundingClientRect();
        const key = `${r.left},${r.top},${r.width},${r.height},${e?.left},${e?.right}`;
        if (key !== lastKey) {
          lastKey = key;
          this.reposition();
        }
        followFrame = requestAnimationFrame(tick);
      };
      followFrame = requestAnimationFrame(tick);
    },

    closePanel() {
      if (followFrame) cancelAnimationFrame(followFrame);
      followFrame = 0;
      this.releaseSidebar();
      panel?.classList.remove("zp-open");
    },

    // Panel width and animation speed (applied on every show).
    configure({ width, motion }) {
      const root = this.panelRoot();
      if (root) root.style.width = `${width}px`;
      panel?.setAttribute("zp-motion", motion);
    },

    removePanel() {
      if (followFrame) cancelAnimationFrame(followFrame);
      followFrame = 0;
      this.releaseSidebar();
      resizeObserver?.disconnect();
      resizeObserver = null;
      panel?.remove();
      panel = null;
      panelStyle = null;
      onAnchorLost = null;
      this._anchor = null;
    },

    html(tagName, props = {}, children = []) {
      const el = document.createElementNS(HTML, tagName);
      for (const [k, v] of Object.entries(props)) {
        if (k === "text") el.textContent = v;
        else if (k === "class") el.className = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
      el.append(...children.filter(Boolean));
      return el;
    },

    // Open a link from a card: in the hovered tab when it's the same site, else a new tab.
    openLink(url, fromTab, { newTab = false } = {}) {
      if (!/^https?:\/\//.test(url)) return;
      let same = false;
      try {
        same = new URL(url).host === new URL(this.tabUrl(fromTab)).host;
      } catch { /* different */ }
      if (same && !newTab) {
        gBrowser.selectedTab = fromTab;
        openTrustedLinkIn(url, "current");
      } else {
        openTrustedLinkIn(url, "tab");
      }
    },

    // Extra items on the tab right-click menu; `show(tab)` decides visibility and
    // `label()` the text (read each time, so a language change applies at once).
    // Returns a function that removes them again. Items left by an older copy
    // (after an update without restart) are replaced, never duplicated.
    addTabMenuItems(items) {
      const menu = document.getElementById("tabContextMenu");
      if (!menu) return () => {};
      for (const old of menu.querySelectorAll("[id^='zen-peek-menu-']")) old.remove();
      const sep = document.createXULElement("menuseparator");
      sep.id = "zen-peek-menu-separator";
      const els = items.map(({ id, command }) => {
        const mi = document.createXULElement("menuitem");
        mi.id = `zen-peek-menu-${id}`;
        mi.addEventListener("command", () => command(TabContextMenu.contextTab));
        return mi;
      });
      menu.append(sep, ...els);
      const onShowing = (e) => {
        if (e.target !== menu) return;
        const tab = TabContextMenu.contextTab;
        let any = false;
        items.forEach((it, i) => {
          const visible = !!tab && it.show(tab);
          els[i].hidden = !visible;
          if (visible) els[i].setAttribute("label", it.label());
          any ||= visible;
        });
        sep.hidden = !any;
      };
      menu.addEventListener("popupshowing", onShowing);
      return () => {
        menu.removeEventListener("popupshowing", onShowing);
        sep.remove();
        for (const el of els) el.remove();
      };
    },
  };
})();
