import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AssetQrScanner } from "@/components/asset-qr-scanner";
import { requireActiveAssetAccount } from "@/lib/asset-page-access";
import styles from "../asset-page.module.css";

export const dynamic = "force-dynamic";

export default async function ScanAssetPage() {
  const { canManageAssets } = await requireActiveAssetAccount("/assets/scan");
  return (
    <main className={styles.page}>
      <nav className={styles.navigation} aria-label="Devices">
        <Link href={canManageAssets ? "/?view=people&tab=assets" : "/?view=people"} className={styles.back}>
          <ArrowLeft size={18} aria-hidden="true" />{canManageAssets ? "Devices" : "People"}
        </Link>
      </nav>
      <section className={styles.card}>
        <h1>Scan device QR</h1>
        <AssetQrScanner />
      </section>
    </main>
  );
}
