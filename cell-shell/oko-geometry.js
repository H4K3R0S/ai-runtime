"use strict";
/** Viewport CSS-rect + ekranski origin (DIP) + scale → apsolutni device-px rect. */
function viewportToDevice(rect, contentBounds, scaleFactor) {
  const sf = scaleFactor || 1;
  return {
    x: Math.round((contentBounds.x + rect.left) * sf),
    y: Math.round((contentBounds.y + rect.top) * sf),
    w: Math.round(rect.w * sf),
    h: Math.round(rect.h * sf),
  };
}
module.exports = { viewportToDevice };
