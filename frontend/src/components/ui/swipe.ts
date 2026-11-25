/**
 * When a sideways drag over a photo means "next / previous photo" (site and app, the same rule).
 *
 * 15/11/2026: the swipe only worked dragging from the right edge to the middle. The rule used to be "more
 * than 60 points, and less than 60 up or down", judged by distance only: the short, quick flick people make with a
 * thumb was lost. Now, like photo galleries do, either a short drag or a quick flick counts, as long as the movement
 * is more sideways than up or down.
 *
 * dx, dy: travel in points (px on the site); speed: sideways speed in points per second.
 * Returns 1 (next photo, finger moved left), -1 (previous) or 0 (not a swipe).
 */
export const SWIPE_DISTANCE = 40;   // a drag of about a finger's width
export const FLICK_DISTANCE = 15;   // a flick needs at least this, so a tap that wobbles is not a swipe
export const FLICK_SPEED = 300;     // points per second

export function swipeDirection(dx: number, dy: number, speed: number): 1 | -1 | 0 {
  'worklet';   // also runs on the app's gesture thread (react-native-reanimated)
  const ax = Math.abs(dx);
  if (ax < FLICK_DISTANCE || ax < Math.abs(dy) * 1.2) return 0;
  if (ax < SWIPE_DISTANCE && Math.abs(speed) < FLICK_SPEED) return 0;
  return dx < 0 ? 1 : -1;
}
