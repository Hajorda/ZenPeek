// Zen Peek — every call into Zen/Firefox internals lives here.
// Checked against zen-browser/desktop @ 13d57d0 (2026-09-29).
//
// Internals relied on:
//   tab[zen-essential], tab.pinned, tab._zenPinnedInitialState.entry.url,
//   gBrowser.{tabContainer, selectedTab, selectedBrowser, getIcon},
//   browsingContext.currentWindowGlobal.drawSnapshot (as Zen's Glance uses it),
//   gZenVerticalTabsManager._prefsRightSide (which side the card opens on),
//   gZenWorkspaces.{promiseInitialized, privateWindowOrDisabled}, #tabContextMenu, TabContextMenu.contextTab,
//   openTrustedLinkIn
// eslint-disable-next-line no-var
var ZPZen = (() => {
  "use strict";
  const HTML = "http://www.w3.org/1999/xhtml";
  let panel = null;
  let panelStyle = null;

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

    // --- Popup -----------------------------------------------------------------

    // Two styles:
    //  "card"  — a floating card drawn in Zen's own window; glides between Essentials.
    //  "popup" — Zen's native popup with an arrow (the original style). It is
    //            reopened rather than moved, because moving a native popup can
    //            leave a ghost frame behind.
    panel({ onEnter, onLeave, style = "card" }) {
      if (panel && panelStyle === style) return panel;
      this.removePanel();
      // Also remove a card or popup left by an older copy (update without restart).
      for (const old of document.querySelectorAll("#zen-peek-panel")) {
        try {
          old.hidePopup?.();
        } catch { /* not a popup */ }
        old.remove();
      }
      const root = document.createElementNS(HTML, "div");
      root.id = "zen-peek-root";
      if (style === "popup") {
        panel = document.createXULElement("panel");
        panel.setAttribute("noautofocus", "true");
        panel.setAttribute("consumeoutsideclicks", "false");
        panel.setAttribute("level", "parent");
        panel.append(root);
        document.getElementById("mainPopupSet").append(panel);
      } else {
        panel = document.createElementNS(HTML, "div");
        panel.className = "zp-card";
        panel.append(root);
        document.documentElement.append(panel);
        // Keep it on screen when its content grows or shrinks.
        new ResizeObserver(() => this.reposition()).observe(root);
      }
      panel.id = "zen-peek-panel";
      panelStyle = style;
      panel.addEventListener("mouseenter", onEnter);
      panel.addEventListener("mouseleave", onLeave);
      return panel;
    },

    panelRoot: () => panel?.querySelector("#zen-peek-root"),
    panelOpen() {
      if (!panel) return false;
      if (panelStyle === "popup") return panel.state === "open" || panel.state === "showing";
      return panel.classList.contains("zp-open");
    },

    // Card style: place the card beside the sidebar, kept inside the window.
    reposition() {
      if (panelStyle !== "card" || !panel || !this._anchor || !this.panelOpen()) return;
      const r = this._anchor.getBoundingClientRect();
      const w = panel.offsetWidth || 320;
      const h = panel.offsetHeight || 120;
      const gap = 8;
      const right = !!gZenVerticalTabsManager?._prefsRightSide;
      // Open outside the sidebar, so the card never covers other Essentials.
      const sidebar = document.getElementById("navigator-toolbox");
      const edge = sidebar?.contains(this._anchor) ? sidebar.getBoundingClientRect() : r;
      let x = right ? edge.left - w - gap : edge.right + gap;
      let y = r.top - 6;
      x = Math.max(gap, Math.min(x, window.innerWidth - w - gap));
      y = Math.max(gap, Math.min(y, window.innerHeight - h - gap));
      panel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },

    openPanel(anchor) {
      const moved = this._anchor !== anchor;
      this._anchor = anchor;
      if (panelStyle === "popup") {
        if (this.panelOpen()) {
          if (!moved) return;
          panel.hidePopup(); // reopen at the new Essential instead of moving
        }
        const right = !!gZenVerticalTabsManager?._prefsRightSide;
        panel.openPopup(anchor, { position: right ? "topleft topright" : "topright topleft", x: right ? -8 : 8, y: 0 });
        return;
      }
      if (this.panelOpen()) {
        this.reposition(); // already visible: glide to the new Essential
        return;
      }
      // First show: jump into place without the glide, then fade in.
      panel.classList.add("zp-instant", "zp-open");
      this.reposition();
      panel.getBoundingClientRect();
      panel.classList.remove("zp-instant");
    },

    closePanel() {
      if (!panel) return;
      if (panelStyle === "popup") {
        if (this.panelOpen()) panel.hidePopup();
      } else {
        panel.classList.remove("zp-open");
      }
    },

    // Card width and animation speed (applied on every show).
    configure({ width, motion }) {
      const root = this.panelRoot();
      if (root) root.style.width = `${width}px`;
      panel?.setAttribute("zp-motion", motion);
    },

    removePanel() {
      try {
        panel?.hidePopup?.();
      } catch { /* not open */ }
      panel?.remove();
      panel = null;
      panelStyle = null;
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

    // Extra items on the tab right-click menu; `show(tab)` decides visibility.
    addTabMenuItems(items) {
      const menu = document.getElementById("tabContextMenu");
      if (!menu) return;
      const sep = document.createXULElement("menuseparator");
      const els = items.map(({ label, command }) => {
        const mi = document.createXULElement("menuitem");
        mi.setAttribute("label", label);
        mi.addEventListener("command", () => command(TabContextMenu.contextTab));
        return mi;
      });
      menu.append(sep, ...els);
      menu.addEventListener("popupshowing", (e) => {
        if (e.target !== menu) return;
        const tab = TabContextMenu.contextTab;
        let any = false;
        items.forEach((it, i) => {
          const visible = !!tab && it.show(tab);
          els[i].hidden = !visible;
          any ||= visible;
        });
        sep.hidden = !any;
      });
    },
  };
})();
