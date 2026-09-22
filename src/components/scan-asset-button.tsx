import Link from "next/link";
import { ScanLine } from "lucide-react";

export function ScanAssetButton({ className }: { className?: string }) {
  return (
    <Link href="/assets/scan" className={className}>
      <ScanLine size={18} aria-hidden="true" />
      <span>Scan QR</span>
    </Link>
  );
}
