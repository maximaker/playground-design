/**
 * A component as it would exist in a real project. Nothing here knows about
 * Playground — that is the point: designing with it must not require the code
 * to be written for the design tool.
 */
export interface ButtonProps {
  label?: string;
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}

const PADDING = { sm: '7px 12px', md: '11px 20px', lg: '15px 28px' };
const FONT = { sm: 13, md: 15, lg: 17 };

const TONE: Record<string, { background: string; color: string; border: string }> = {
  primary: { background: '#4f46e5', color: '#ffffff', border: '1px solid transparent' },
  ghost: { background: 'transparent', color: '#4f46e5', border: '1px solid #c7d2fe' },
  danger: { background: '#dc2626', color: '#ffffff', border: '1px solid transparent' },
};

export default function Button({ label = 'Button', variant = 'primary', size = 'md', disabled = false }: ButtonProps) {
  const tone = TONE[variant] ?? TONE.primary!;
  return (
    <button
      disabled={disabled}
      style={{
        ...tone,
        padding: PADDING[size] ?? PADDING.md,
        fontSize: FONT[size] ?? FONT.md,
        fontWeight: 600,
        borderRadius: 8,
        fontFamily: 'Inter, system-ui, sans-serif',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
