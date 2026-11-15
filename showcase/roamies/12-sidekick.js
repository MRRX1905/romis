// The chosen sidekick: the LED matrix dither blob, without the drips, with the agent layer on top.
Roamie.register(Roamie.ditherKit({
  id: 'sidekick', label: 'Sidekick', matrix: true, pixel: 1.3, glow: 0.55, speed: 80,
  pal: [[5, 8, 10], [58, 17, 20], [122, 27, 32], [179, 19, 27], [230, 231, 234]],
  plugin: (kit) => Roamie.agentPlugin?.(kit) ?? null,
}));
