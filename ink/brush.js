// One reachable brush model for live input, demonstrations and ink masks.
// All geometry is in CSS pixels. This module never reads a target silhouette.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const TAU = Math.PI * 2;

function angleDelta(from, to) {
  return ((to - from + Math.PI * 3) % TAU) - Math.PI;
}

function mousePressure(speed) {
  // A slow movement lays the belly down; a fast exit pulls the tip out.
  return .025 + .89 / (1 + (Math.max(0, speed) / .48) ** 1.6);
}

function footprint(size, pressure, tangent, speed) {
  const radius = size * (.06 + .94 * pressure);
  const angle = -Math.PI / 4 + Math.sin(tangent + Math.PI / 4) * .13;
  const rx = Math.max(.22, radius * 1.06);
  const ry = Math.max(.16, radius * (.69 - .06 * clamp(speed / 3, 0, 1)));
  // Width normal to travel is useful for comparing the demo and user's mark.
  const normal = tangent + Math.PI / 2 - angle;
  const width = 2 * Math.hypot(rx * Math.cos(normal), ry * Math.sin(normal));
  return { rx, ry, angle, width };
}

function frozenFootprint(stamp) {
  return Object.freeze({ x: stamp.x, y: stamp.y, rx: stamp.rx, ry: stamp.ry, angle: stamp.angle });
}

export class BrushStroke {
  constructor({ size = 9, input = 'mouse' } = {}) {
    this.size = clamp(finite(size, 9), .5, 70);
    this.input = input;
    this.lastSample = null;
    this.lastFootprint = null;
    this.ended = false;
  }

  add(sample) {
    if (this.ended || !sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return [];
    const previous = this.lastSample;
    const x = sample.x;
    const y = sample.y;
    const time = previous
      ? Math.max(previous.time + .5, finite(sample.time, previous.time + 16))
      : finite(sample.time, 0);
    const pen = (sample.pointerType || this.input) === 'pen';
    const sensed = pen && Number.isFinite(sample.pressure) && (sample.pressure > 0 || sample.ending);

    if (!previous) {
      const pressure = sensed ? clamp(sample.pressure, .025, 1) : .56;
      const shape = footprint(this.size, pressure, 0, 0);
      const stamp = Object.freeze({ x, y, ...shape, opacity: 1, at: time, from: null });
      this.lastFootprint = frozenFootprint(stamp);
      this.lastSample = Object.freeze({ x, y, time, pressure, speed: 0, tangent: 0, width: shape.width });
      return [stamp];
    }

    const dx = x - previous.x;
    const dy = y - previous.y;
    const travelled = Math.hypot(dx, dy);
    // A pointer-up at rest cannot add a new blob or manufacture a sharp end.
    if (sample.ending && travelled < .01) return [];
    const dt = time - previous.time;
    const instantSpeed = clamp(travelled / dt, 0, 12);
    const speed = previous.speed + (instantSpeed - previous.speed) * (1 - Math.exp(-dt / 12));
    const desiredPressure = sensed ? clamp(sample.pressure, .025, 1) : mousePressure(speed);
    const pressure = previous.pressure + (desiredPressure - previous.pressure) * (1 - Math.exp(-dt / 9));
    const tangent = travelled > .01 ? Math.atan2(dy, dx) : previous.tangent;
    const shape = footprint(this.size, pressure, tangent, speed);
    const initial = this.lastFootprint;
    const count = Math.min(128, Math.max(1, Math.ceil(travelled / 1.35)));
    const stamps = [];
    let from = initial;
    for (let index = 1; index <= count; index++) {
      const t = index / count;
      const stamp = Object.freeze({
        x: previous.x + dx * t,
        y: previous.y + dy * t,
        rx: initial.rx + (shape.rx - initial.rx) * t,
        ry: initial.ry + (shape.ry - initial.ry) * t,
        angle: initial.angle + angleDelta(initial.angle, shape.angle) * t,
        opacity: 1,
        at: previous.time + dt * t,
        from,
      });
      stamps.push(stamp);
      from = frozenFootprint(stamp);
    }
    this.lastFootprint = from;
    this.lastSample = Object.freeze({ x, y, time, pressure, speed, tangent, width: shape.width });
    return stamps;
  }

  end() {
    this.ended = true;
    // End geometry already comes from the user's final moving samples.
    return [];
  }
}

function ellipseSupport(mark, nx, ny) {
  const c = Math.cos(mark.angle);
  const s = Math.sin(mark.angle);
  const localX = c * nx + s * ny;
  const localY = -s * nx + c * ny;
  const denominator = Math.hypot(mark.rx * localX, mark.ry * localY) || 1;
  const x = mark.rx * mark.rx * localX / denominator;
  const y = mark.ry * mark.ry * localY / denominator;
  return { x: c * x - s * y, y: s * x + c * y };
}

function traceNib(context, mark) {
  const c = Math.cos(mark.angle);
  const s = Math.sin(mark.angle);
  const point = (x, y) => [mark.x + c * mark.rx * x - s * mark.ry * y, mark.y + s * mark.rx * x + c * mark.ry * y];
  // A softly squared, angled nib leaves recognisable press and turn forms.
  // The same shape is used for both teacher and learner; no font clipping.
  const shoulder = .72;
  context.moveTo(...point(0, -1));
  context.bezierCurveTo(...point(shoulder, -1), ...point(1, -shoulder), ...point(1, 0));
  context.bezierCurveTo(...point(1, shoulder), ...point(shoulder, 1), ...point(0, 1));
  context.bezierCurveTo(...point(-shoulder, 1), ...point(-1, shoulder), ...point(-1, 0));
  context.bezierCurveTo(...point(-1, -shoulder), ...point(-shoulder, -1), ...point(0, -1));
  context.closePath();
}

export function paintBrushStamps(context, stamps, color = '#fff') {
  if (!context || !Array.isArray(stamps) || !stamps.length) return;
  context.save();
  const inheritedAlpha = context.globalAlpha;
  context.fillStyle = color;
  let opacity = null;
  for (const stamp of stamps) {
    const nextOpacity = clamp(finite(stamp.opacity, 1), 0, 1);
    if (opacity !== nextOpacity) {
      if (opacity !== null) context.fill();
      opacity = nextOpacity;
      context.globalAlpha = inheritedAlpha * opacity;
      context.beginPath();
    }
    const from = stamp.from;
    if (from) {
      const dx = stamp.x - from.x;
      const dy = stamp.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length > .001) {
        const nx = -dy / length;
        const ny = dx / length;
        const a = ellipseSupport(from, nx, ny);
        const b = ellipseSupport(stamp, nx, ny);
        // Match the nib contour's winding so overlap is a union, not a hole.
        context.moveTo(from.x - a.x, from.y - a.y);
        context.lineTo(stamp.x - b.x, stamp.y - b.y);
        context.lineTo(stamp.x + b.x, stamp.y + b.y);
        context.lineTo(from.x + a.x, from.y + a.y);
        context.closePath();
      }
    }
    traceNib(context, stamp);
  }
  if (opacity !== null) context.fill();
  context.restore();
}

function resamplePath(input) {
  const points = [];
  for (const value of input || []) {
    const point = Array.isArray(value) ? { x: value[0], y: value[1] } : value;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = points[points.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > .001) points.push({ x: point.x, y: point.y });
  }
  if (points.length < 2) return points;
  const lengths = [0];
  for (let index = 1; index < points.length; index++) {
    lengths.push(lengths[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  const total = lengths[lengths.length - 1];
  const count = clamp(Math.ceil(total / 3), 24, 180);
  const result = [];
  let segment = 1;
  for (let index = 0; index <= count; index++) {
    const at = total * index / count;
    while (segment < points.length - 1 && lengths[segment] < at) segment++;
    const a = points[segment - 1];
    const b = points[segment];
    const t = (at - lengths[segment - 1]) / Math.max(.001, lengths[segment] - lengths[segment - 1]);
    result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return result;
}

function demoTime(progress, finish) {
  if (progress <= .1) return .18 * (progress / .1) ** .7;
  if (finish === 'stop') {
    if (progress <= .86) return .18 + .57 * (progress - .1) / .76;
    return .75 + .25 * (progress - .86) / .14;
  }
  if (progress <= .88) return .18 + .8 * (progress - .1) / .78;
  return .98 + .02 * ((progress - .88) / .12) ** .55;
}

export function createBrushDemo(points, { size = 9, input = 'mouse', duration = 2400, finish = 'lift' } = {}) {
  const path = resamplePath(points);
  const runTime = clamp(finite(duration, 2400), 350, 10000);
  const stroke = new BrushStroke({ size, input });
  const samples = [];
  const stamps = [];
  const profile = [];
  path.forEach((point, index) => {
    const progress = path.length > 1 ? index / (path.length - 1) : 0;
    const pressure = finish === 'stop'
      ? .52 + Math.sin(progress * Math.PI / 2) * .32
      : clamp(.65 + Math.sin(progress * Math.PI) * .2 - Math.max(0, (progress - .78) / .22) * .62, .035, .9);
    const sample = { ...point, time: demoTime(progress, finish) * runTime, pointerType: input === 'pen' ? 'pen' : 'mouse', pressure };
    samples.push(sample);
    stamps.push(...stroke.add(sample));
    if (stroke.lastSample) profile.push({ ...stroke.lastSample });
  });
  stamps.push(...stroke.end());
  return { samples, stamps, profile, duration: profile.length ? profile[profile.length - 1].time : runTime };
}
