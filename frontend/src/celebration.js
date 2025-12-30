import confetti from "canvas-confetti";

function burst(originX = 0.5, originY = 0.65) {
  const origin = { x: originX, y: originY };

  // Burst principal
  confetti({
    particleCount: 180,
    spread: 80,
    startVelocity: 55,
    gravity: 1.15,
    scalar: 1.0,
    ticks: 220,
    origin,
  });

  // "Side cannons" pour effet stade / event
  confetti({
    particleCount: 90,
    angle: 60,
    spread: 55,
    startVelocity: 45,
    gravity: 1.2,
    scalar: 0.95,
    ticks: 240,
    origin: { x: 0.1, y: 0.75 },
  });

  confetti({
    particleCount: 90,
    angle: 120,
    spread: 55,
    startVelocity: 45,
    gravity: 1.2,
    scalar: 0.95,
    ticks: 240,
    origin: { x: 0.9, y: 0.75 },
  });
}

function fireworks(durationMs = 1800) {
  const end = Date.now() + durationMs;

  (function frame() {
    // Petits pops aléatoires pour effet feu d’artifice
    confetti({
      particleCount: 14,
      startVelocity: 28,
      spread: 360,
      ticks: 140,
      gravity: 0.9,
      scalar: 0.9,
      origin: { x: Math.random(), y: Math.random() * 0.45 + 0.1 },
    });

    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

export function runCelebration() {
  // Reset pour éviter superposition si appel multiple
  confetti.reset();

  // 1) Fireworks au-dessus
  fireworks(1700);

  // 2) Burst central + canons latéraux
  burst(0.5, 0.68);
}
