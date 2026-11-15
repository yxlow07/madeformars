// Cache-buster for baked data: one value per page load, so re-baked files always show up.
export const BUST = `?v=${Date.now().toString(36)}`;
