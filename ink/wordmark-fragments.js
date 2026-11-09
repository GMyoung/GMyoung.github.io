const CUTS = [8, 6, 5, 5, 6, 6];
const FIRST_LETTER = .075;
const LETTER_SPAN = .15;
const ASSEMBLED = .54;
const DEPART_AT = .71;

const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

function boundsOf(pixels, width) {
  let left = width, top = Infinity, right = 0, bottom = 0;
  for (const index of pixels) {
    const x = index % width, y = Math.floor(index / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function makeSprite(source, pixels) {
  const box = boundsOf(pixels, source.width);
  const canvas = document.createElement('canvas');
  canvas.width = box.width;
  canvas.height = box.height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(box.width, box.height);
  for (const index of pixels) {
    const x = index % source.width - box.left;
    const y = Math.floor(index / source.width) - box.top;
    image.data.set(source.data.subarray(index * 4, index * 4 + 4), (y * box.width + x) * 4);
  }
  context.putImageData(image, 0, 0);
  return { canvas, ...box };
}

function splitLetter(pixels, count, width) {
  const groups = [pixels];
  while (groups.length < count) {
    const largest = groups.reduce((best, group, i) => group.length > groups[best].length ? i : best, 0);
    const group = groups[largest];
    if (group.length < 2) break;
    const box = boundsOf(group, width);
    const slope = groups.length % 2 ? .34 : -.28;
    const key = box.width > box.height
      ? index => index % width + Math.floor(index / width) * slope
      : index => Math.floor(index / width) + (index % width) * slope;
    group.sort((a, b) => key(a) - key(b));
    const middle = Math.floor(group.length / 2);
    groups.splice(largest, 1, group.slice(0, middle), group.slice(middle));
  }
  return groups;
}

function pixelsByLetter(context, source, contours) {
  const letters = contours.map(points => {
    const path = new Path2D();
    points.forEach(([x, y], i) => path[i === 0 ? 'moveTo' : 'lineTo'](x, y));
    path.closePath();
    const xs = points.map(([x]) => x);
    return { path, center: (Math.min(...xs) + Math.max(...xs)) / 2, pixels: [] };
  });
  for (let index = 0; index < source.width * source.height; index++) {
    if (source.data[index * 4 + 3] === 0) continue;
    const x = index % source.width + .5, y = Math.floor(index / source.width) + .5;
    // At overlapping contours, choose the nearer letter. Keep the original
    // antialiased edge pixels even when their centers are just outside a path.
    let nearest, contained, distance = Infinity, insideDistance = Infinity;
    for (const letter of letters) {
      const gap = Math.abs(x - letter.center);
      if (gap < distance) { nearest = letter; distance = gap; }
      if (gap < insideDistance && context.isPointInPath(letter.path, x, y)) {
        contained = letter;
        insideDistance = gap;
      }
    }
    (contained ?? nearest).pixels.push(index);
  }
  return letters.map(letter => letter.pixels);
}

function orbit(piece, radius, edge, time, progress, still) {
  const index = piece.index;
  const spread = smooth(progress);
  const angle = index * 2.399963 + Math.sin(index * 1.17) * .24 + spread * (.35 + index % 3 * .10);
  const near = radius * (.30 + (index * 7 % 17) / 16 * 1.20);
  const distance = Math.min(near * (1 + .36 * spread), edge * .41);
  const drift = still ? 0 : 9 + index % 5 * 2.5;
  return {
    x: Math.cos(angle) * distance + Math.sin(time * .56 + index * 1.7) * drift,
    y: Math.sin(angle) * distance * (.80 + .20 * spread) + Math.cos(time * .64 + index * 2.1) * drift,
    angle: angle + Math.sin(index * 2.1) * 1.15 + (still ? 0 : Math.sin(time * .53 + index) * .20),
    scale: (.44 + index % 4 * .055) * Math.max(.52, radius / 112) * (1 + spread * .12),
  };
}

function drawPiece(context, piece, x, y, angle, scale) {
  const width = piece.width * scale, height = piece.height * scale;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.drawImage(piece.canvas, -width / 2, -height / 2, width, height);
  context.restore();
}

export class WordmarkFragments {
  constructor(context, source, contours) {
    this.assemblyVisible = false;
    let index = 0;
    this.letters = pixelsByLetter(context, source, contours).map((pixels, letter) => {
      if (!pixels.length) throw new Error('A Harvey letter has no visible pixels');
      const sprite = makeSprite(source, pixels);
      const pieces = splitLetter(pixels, CUTS[letter], source.width).map(group => ({ ...makeSprite(source, group), index: index++ }));
      return { sprite, pieces };
    });
  }

  stage(progress) {
    return Math.floor((progress - FIRST_LETTER) / LETTER_SPAN);
  }

  drawOrbit(context, { radius, edge, time, progress, focused, still }) {
    const waiting = this.letters.slice(this.stage(progress) + 1).flatMap(letter => letter.pieces);
    const poses = waiting.map(piece => orbit(piece, radius, edge, time, progress, still));
    const extent = poses.reduce((maximum, pose, i) => {
      const piece = waiting[i];
      return Math.max(maximum, Math.max(Math.abs(pose.x), Math.abs(pose.y)) + Math.hypot(piece.width, piece.height) * pose.scale / 2);
    }, radius * 1.75);
    const span = 2 * (extent + 10);
    const side = context.canvas.width;
    const unit = side / span;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, side, side);
    context.save();
    context.setTransform(unit, 0, 0, unit, side / 2, side / 2);
    if (focused) {
      context.shadowColor = '#f7f09f';
      context.shadowBlur = 3;
    }
    poses.forEach((pose, i) => drawPiece(context, waiting[i], pose.x, pose.y, pose.angle, pose.scale));
    context.restore();
    return span;
  }

  drawAssembly(context, { width, height, angle, time, shakeX, shakeY, fragmentProgress, marks }) {
    const letter = this.stage(fragmentProgress);
    const visible = letter >= 0 && letter < this.letters.length;
    if (this.assemblyVisible || visible) context.clearRect(0, 0, width, height);
    this.assemblyVisible = visible;
    if (!visible) return;
    const phase = (fragmentProgress - FIRST_LETTER - letter * LETTER_SPAN) / LETTER_SPAN;
    const { sprite, pieces } = this.letters[letter];
    const scale = Math.min(1.45, width * .28 / sprite.width, height * .23 / sprite.height);
    const glyphWidth = sprite.width * scale, glyphHeight = sprite.height * scale;
    const left = (width - glyphWidth) / 2, top = height * .47 - glyphHeight / 2;
    if (phase >= ASSEMBLED) {
      const exit = clamp((phase - DEPART_AT) / (1 - DEPART_AT)) ** 2;
      const side = letter % 2 ? -1 : 1;
      const travel = side * (width / 2 + glyphWidth + 24);
      context.drawImage(sprite.canvas, left + travel * exit, top - Math.min(95, height * .16) * exit,
        glyphWidth, glyphHeight);
      return;
    }
    const radius = Math.min(112, width * .26, height * .245);
    const edge = Math.min(width, height);
    const c = Math.cos(angle), s = Math.sin(angle);
    context.save();
    pieces.forEach((piece, index) => {
      const delay = index * .018;
      const travel = smooth((phase - delay) / (ASSEMBLED - delay));
      const start = orbit(piece, radius, edge, time, fragmentProgress, false);
      const fromX = width / 2 + shakeX + start.x * c - start.y * s;
      const fromY = height / 2 + shakeY + start.x * s + start.y * c;
      const toX = left + (piece.left - sprite.left + piece.width / 2) * scale;
      const toY = top + (piece.top - sprite.top + piece.height / 2) * scale;
      const bow = Math.sin(Math.PI * travel) * Math.min(38, glyphWidth * .22) * (index % 2 ? -.76 : 1);
      const turn = Math.atan2(Math.sin(start.angle + angle), Math.cos(start.angle + angle)) * (1 - travel);
      context.globalAlpha = marks + (1 - marks) * travel;
      drawPiece(context, piece, fromX + (toX - fromX) * travel,
        fromY + (toY - fromY) * travel + bow, turn, start.scale + (scale - start.scale) * travel);
    });
    context.restore();
  }
}
