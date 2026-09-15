// Motion tokens follow the People Hub interaction system: quick to respond,
// gently eased at rest, and never used for repeated list or calendar content.
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

export const SPRING_PRESS = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;
