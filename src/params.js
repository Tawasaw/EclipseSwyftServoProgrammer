// Servo parameter definitions and unit conversions (UI name -> firmware field).

export const PARAMETERS = [
  {
    key: "torque",
    name: "P Coefficient",
    unit: "",
    min: 0,
    max: 255,
    description:
      "Proportional: how strongly the servo reacts to the error between its current and target position. Higher P = faster response, but can cause overshoot or oscillation.",
  },
  {
    key: "integralProportion",
    name: "I Coefficient",
    unit: "",
    min: 0,
    max: 255,
    description:
      "Integral: corrects accumulated error over time, removing steady-state offset. Higher I = removes offset faster, but can reduce stability.",
  },
  {
    key: "brake",
    name: "D Coefficient",
    unit: "",
    min: 0,
    max: 65535,
    sliderMax: 1000,
    description:
      "Derivative: dampens the response to reduce overshoot and oscillation. Higher D = smoother response, but can slow the servo down.",
  },
  {
    key: "integralSpeed",
    name: "Integral speed",
    unit: "×3 ms",
    min: 0,
    max: 255,
    description: "Integration interval. Higher values integrate more slowly.",
  },
  {
    key: "minPulse",
    name: "Min Signal",
    unit: "µs",
    min: 500,
    max: 2500,
    description: "PWM signal value corresponding to the servo's leftmost position.",
  },
  {
    key: "maxPulse",
    name: "Max Signal",
    unit: "µs",
    min: 500,
    max: 2500,
    description: "PWM signal value corresponding to the servo's rightmost position.",
  },
  {
    key: "center",
    name: "Middle Signal",
    unit: "µs",
    min: 500,
    max: 2500,
    description: "PWM signal value for the servo's center position. Recommended: 1500.",
  },
  {
    key: "sensitivity",
    name: "Dead Zone",
    unit: "µs",
    min: 0,
    max: 255,
    description:
      "How close the servo must be to its target before it stops correcting. Smaller = higher precision but may add jitter.",
  },
  {
    key: "maxDuty",
    name: "Max Power",
    unit: "",
    min: 0,
    max: 500,
    description: "Maximum power output to the servo motor (0–500, where 500 is full power).",
  },
];

export const FLAGS = [
  {
    key: "directionReverse",
    name: "Reverse direction",
    description: "Swaps left and right. Off = default direction.",
  },
  {
    key: "stallProtection",
    name: "Stall protection",
    description: "Shuts off the servo if stalled for over 10 seconds to prevent damage.",
  },
  {
    key: "softStart",
    name: "Ramp mode",
    description: "Limits the initial current surge at startup.",
  },
];

export const MAX_TRAVEL_DEGREES = 320;
export const CONTINUOUS_ROTATION_VALUE = 255;

/** Recommended factory defaults for a standard (non-continuous) SWYFT servo. */
export const DEFAULTS = {
  torque: 19,
  integralProportion: 13,
  brake: 47,
  integralSpeed: 20,
  minPulse: 500,
  maxPulse: 2500,
  center: 1500,
  sensitivity: 5,
  maxDuty: 400,
  bigAngle: 111, // Left range  -> Total Range 270°
  smallAngle: 111, // Right range
  directionReverse: true,
  stallProtection: true,
  softStart: true,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Per-side range value V <-> total travel degrees, from the calibration points
// 130 -> 320° and 111 -> 270°:  degrees = (50V - 420) / 19.
export const degreesToRangeValue = (deg) =>
  clamp(Math.round((19 * clamp(deg, 0, MAX_TRAVEL_DEGREES) + 420) / 50), 0, 255);

export const rangeValueToDegrees = (v) =>
  clamp(Math.round((50 * v - 420) / 19), 0, MAX_TRAVEL_DEGREES);

/** Converts raw firmware parameters into the editable form model. */
export function toForm(p) {
  const continuous = p.bigAngle >= CONTINUOUS_ROTATION_VALUE && p.smallAngle >= CONTINUOUS_ROTATION_VALUE;
  const form = {
    continuous,
    totalRange: continuous ? 270 : rangeValueToDegrees(Math.round((p.bigAngle + p.smallAngle) / 2)),
  };
  for (const def of PARAMETERS) form[def.key] = p[def.key];
  for (const flag of FLAGS) form[flag.key] = !!p[flag.key];
  return form;
}

/** Converts the form model back into raw firmware parameters. */
export function fromForm(form) {
  const range = form.continuous ? CONTINUOUS_ROTATION_VALUE : degreesToRangeValue(form.totalRange);
  const p = { bigAngle: range, smallAngle: range };
  for (const def of PARAMETERS) p[def.key] = form[def.key];
  for (const flag of FLAGS) p[flag.key] = !!form[flag.key];
  return p;
}

export function isValid(def, value) {
  return Number.isInteger(value) && value >= def.min && value <= def.max;
}

export function describe(p) {
  return (
    `P=${p.torque}, I=${p.integralProportion}, D=${p.brake}, IntSpeed=${p.integralSpeed}, ` +
    `Min=${p.minPulse}, Max=${p.maxPulse}, Mid=${p.center}, DeadZone=${p.sensitivity}, ` +
    `Power=${p.maxDuty}, Range(L/R)=${p.bigAngle}/${p.smallAngle}, ` +
    `Dir=${p.directionReverse ? "Reverse" : "Normal"}, Stall=${p.stallProtection ? "On" : "Off"}, ` +
    `Ramp=${p.softStart ? "On" : "Off"}`
  );
}
