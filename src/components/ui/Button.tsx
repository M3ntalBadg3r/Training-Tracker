import Link from "next/link";

/**
 * The shared button.
 *
 * `src/app` held 24 distinct primary-button class strings across 90 uses and 12
 * secondary variants across 77 — most differing only in token order, a stray
 * `transition-colors`, or `rounded-md` where everything else used `rounded-lg`.
 * There was no Button component to reach for, so every page typed one out.
 *
 * `href` switches the element to a `next/link` while keeping the same visual
 * contract, because several of these are navigation dressed as buttons.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  secondary: "bg-gray-200 text-gray-900 hover:bg-gray-300",
  ghost: "text-gray-600 hover:text-gray-900 hover:bg-gray-100",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

const SIZE = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
} as const;

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

type CommonProps = {
  variant?: ButtonVariant;
  size?: keyof typeof SIZE;
  className?: string;
  children: React.ReactNode;
};

type ButtonProps = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & {
    href?: undefined;
  };

type LinkProps = CommonProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & {
    href: string;
  };

export default function Button(props: ButtonProps | LinkProps) {
  const { variant = "primary", size = "md", className = "", children } = props;
  const cls = `${BASE} ${SIZE[size]} ${VARIANT[variant]} ${className}`.trim();

  if (props.href !== undefined) {
    const { variant: _v, size: _s, className: _c, children: _ch, ...rest } = props;
    return (
      <Link {...rest} className={cls}>
        {children}
      </Link>
    );
  }

  const { variant: _v, size: _s, className: _c, children: _ch, ...rest } = props;
  return (
    <button {...rest} className={cls}>
      {children}
    </button>
  );
}
