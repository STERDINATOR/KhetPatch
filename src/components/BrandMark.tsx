import React from 'react';

export function KhetPatchLogo({ light = true }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0">
      <svg
        width="32"
        height="32"
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        {/* Terraced field lines */}
        <path
          d="M5 24.5C10.5 21.5 16.5 21.5 22.5 24.5C25.5 26 28.5 26.2 31 25.5"
          stroke="#A7F33C"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M7 29.5C12.5 26.8 18.5 26.8 24.5 29.5C27 30.6 29 30.8 31 30.2"
          stroke="#27D7ED"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        {/* Sprouting dual leaves */}
        <path
          d="M18 22V14C18 9.8 21.2 6.5 26.5 6C26.2 11.4 22.8 14.8 18 15"
          fill="#A7F33C"
        />
        <path
          d="M18 22V15.5C18 11.8 14.8 8.8 9.5 8.5C9.8 13.5 13 16.5 18 16.8"
          fill="#45B83A"
        />
      </svg>
      <span
        className={`font-display text-lg font-bold tracking-tight ${
          light ? 'text-white' : 'text-[#10251D]'
        }`}
      >
        KhetPatch<sup className="text-[10px] font-medium opacity-75 ml-0.5">™</sup>
      </span>
    </span>
  );
}

export function NasaEmblem() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="16" cy="16" r="14" fill="#0B3D91" stroke="#27D7ED" strokeWidth="1.2" />
      <path
        d="M5 18C10 12 21 10 28 13"
        stroke="#FC3D21"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="11"
        ry="4.5"
        transform="rotate(-24 16 16)"
        stroke="#FFFFFF"
        strokeWidth="1.2"
        strokeOpacity="0.85"
      />
      <text
        x="16"
        y="19"
        textAnchor="middle"
        fill="#FFFFFF"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="sans-serif"
      >
        NASA
      </text>
    </svg>
  );
}
