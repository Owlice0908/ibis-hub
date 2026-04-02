import React from 'react';

interface IbisLogoProps {
  size?: number;
  strokeColor?: string;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * IbisLogo - SVG bird logo rendered as individual stroke paths
 * for line-draw (stroke-dashoffset) animation.
 *
 * Each <path> is a separate stroke so they can be animated sequentially.
 * Paths are ordered from top wing feather down to the tail/body.
 */
const IbisLogo: React.FC<IbisLogoProps> = ({
  size = 200,
  strokeColor = '#1a2e3b',
  strokeWidth = 4.5,
  className,
  style,
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      {/* Wing feather 1 - topmost, longest sweep */}
      <path
        d="M 72 118 C 68 100, 62 78, 70 58 C 78 38, 100 22, 128 18"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Wing feather 2 - second from top */}
      <path
        d="M 68 126 C 62 110, 58 90, 68 72 C 78 54, 100 42, 136 38"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Wing feather 3 - third from top */}
      <path
        d="M 64 134 C 58 120, 56 102, 68 86 C 80 70, 106 58, 142 56"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Wing feather 4 - lowest wing stroke merging into body */}
      <path
        d="M 60 140 C 56 128, 58 114, 72 100 C 86 86, 114 76, 148 74"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Body - main curved body line from wing junction to head/beak */}
      <path
        d="M 60 140 C 80 130, 110 108, 132 96 C 154 84, 170 78, 182 82"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Belly/underside curve */}
      <path
        d="M 60 140 C 74 142, 100 138, 126 128 C 152 118, 170 104, 180 90"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Tail feather 1 - upper tail stroke */}
      <path
        d="M 60 140 C 52 148, 40 158, 28 164 C 16 170, 10 168, 14 160"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Tail feather 2 - lower tail stroke */}
      <path
        d="M 60 140 C 50 152, 36 166, 22 176 C 8 186, 4 184, 10 174"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
};

export default IbisLogo;
