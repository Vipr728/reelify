// Shared visual tokens so every screen looks consistent.
export const colors = {
  bg: '#0B0B0F',
  surface: '#16161D',
  surfaceAlt: '#1E1E28',
  border: '#2A2A36',
  text: '#FFFFFF',
  textMuted: '#9A9AA8',
  accent: '#FF2D55', // reel red
  accentDim: '#7A1730',
  success: '#34C759',
  warn: '#FFCC00',
  danger: '#FF3B30',
};

// Status badge colors for the clip library (ClipStatus).
export const statusColors: Record<string, string> = {
  uploaded: colors.textMuted,
  transcribed: colors.warn,
  embedded: colors.warn,
  analyzed: colors.success,
  ready: colors.success,
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 12, lg: 20, pill: 999 };
