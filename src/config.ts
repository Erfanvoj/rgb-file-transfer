export const GRID_SIZE = 16;
export const CELLS_PER_FRAME = GRID_SIZE * GRID_SIZE; // 256 cells
export const BITS_PER_CELL = 3; // 8 primary/secondary color states = 3 bits
export const BITS_PER_FRAME = CELLS_PER_FRAME * BITS_PER_CELL; // 768 bits
export const BYTES_PER_FRAME = BITS_PER_FRAME / 8; // 96 bytes

export const HEADER_SIZE_BYTES = 9; // Magic(2) + FileID(1) + Seed(2) + TotalChunks(2) + CRC16(2)
export const MAX_PAYLOAD_SIZE = BYTES_PER_FRAME - HEADER_SIZE_BYTES; // 87 bytes

export const MAGIC_BYTES = new Uint8Array([0xAB, 0xCD]);

export const FRAME_HOLD_MS = 160; // ~6.25 FPS baseline for exposure settlement and AWB convergence
export const CLOCK_LOWER_THRESHOLD = 0.25;
export const CLOCK_UPPER_THRESHOLD = 0.75;
export const SENDER_CANVAS_SIZE = 600;

export const CELL_SIZE = 25;
export const DATA_CELL_GUARD_RATIO = 0.10;
export const QUIET_MARGIN = 25;
export const ANCHOR_CELLS = 4;
export const ANCHOR_SIZE = ANCHOR_CELLS * CELL_SIZE;

export const SYNC_CLOCK_CELLS = 2;
export const SYNC_CLOCK_SIZE = SYNC_CLOCK_CELLS * CELL_SIZE;
export const SYNC_CLOCK_X = SENDER_CANVAS_SIZE - QUIET_MARGIN - ANCHOR_SIZE - SYNC_CLOCK_SIZE - 10;
export const SYNC_CLOCK_Y = QUIET_MARGIN + 10;

export const CALIBRATION_STRIP_X = QUIET_MARGIN + ANCHOR_SIZE + 10;
export const CALIBRATION_STRIP_Y = QUIET_MARGIN + 10;
export const CALIBRATION_STRIP_WIDTH = SYNC_CLOCK_X - 10 - CALIBRATION_STRIP_X;
export const CALIBRATION_STRIP_HEIGHT = ANCHOR_SIZE - 20;

export const NORMALIZED_BUFFER_SIZE = 320;
export const THUMBNAIL_SIZE = 100;

export const PALETTE = [
  { hex: '#000000', r: 0, g: 0, b: 0 },
  { hex: '#0000FF', r: 0, g: 0, b: 255 },
  { hex: '#00FF00', r: 0, g: 255, b: 0 },
  { hex: '#00FFFF', r: 0, g: 255, b: 255 },
  { hex: '#FF0000', r: 255, g: 0, b: 0 },
  { hex: '#FF00FF', r: 255, g: 0, b: 255 },
  { hex: '#FFFF00', r: 255, g: 255, b: 0 },
  { hex: '#FFFFFF', r: 255, g: 255, b: 255 },
] as const;

export const ANCHOR_COLOR_TL = '#FF00FF';
export const ANCHOR_COLOR_OTHER = '#00FFFF';
export const ANCHOR_COLOR_CENTER = '#FFFFFF';
