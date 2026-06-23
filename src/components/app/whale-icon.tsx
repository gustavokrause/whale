export function WhaleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {/* body — back arc + belly */}
      <path d="M2.5 13C2.5 9.4 6 7 10.5 7C15 7 18 9.4 18 12.5" />
      <path d="M2.5 13C2.5 16 5.5 17.5 9.5 17.5C12.5 17.5 15.2 16.6 17 15" />
      {/* tail flukes */}
      <path d="M18 12.5C19.6 11.8 20.6 10.4 21 8.5" />
      <path d="M18 12.5C19.8 13 21 14 21.5 15.5" />
      {/* flipper */}
      <path d="M8 16C9 17 10.5 17 11.5 16.2" />
      {/* eye */}
      <circle cx="6" cy="12.5" r="0.8" fill="currentColor" stroke="none" />
      {/* blow spout */}
      <path d="M8.5 7C8.3 5.4 8.8 4.2 10 3.5" />
      <path d="M8.5 7C7.4 6.1 7 4.9 7.2 3.6" />
    </svg>
  );
}
