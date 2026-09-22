import Link from "next/link";
import { ArrowLeft, Laptop } from "lucide-react";
import { notFound } from "next/navigation";
import { listItAssets } from "@/app/assets/actions";
import { listMyItAssets } from "@/app/assets/employee-actions";
import { ScanAssetButton } from "@/components/scan-asset-button";
import { assetQrPath, isAssetCode } from "@/lib/asset-qr";
import { requireActiveAssetAccount } from "@/lib/asset-page-access";
import type { EmployeeItAsset, ItAsset } from "@/lib/it-asset-types";
import styles from "../asset-page.module.css";

export const dynamic = "force-dynamic";

export default async function AssetPage({ params }: { params: Promise<{ assetCode: string }> }) {
  const { assetCode } = await params;
  if (!isAssetCode(assetCode)) notFound();
  const { canManageAssets } = await requireActiveAssetAccount(assetQrPath(assetCode));
  let asset: ItAsset | EmployeeItAsset | undefined;
  try {
    // Existing database projections enforce either full asset administration or
    // the caller's own assigned devices. No new public lookup is introduced.
    const assets = canManageAssets ? await listItAssets() : await listMyItAssets();
    asset = assets.find((candidate) => candidate.assetCode === assetCode);
  } catch {
    notFound();
  }
  if (!asset) notFound();

  const type = asset.assetType === "iphone" ? "iPhone"
    : asset.assetType === "ipad" ? "iPad"
      : asset.assetType === "sim" ? "SIM"
        : asset.assetType === "other" ? "Other device"
          : asset.assetType.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
  const fields = [
    ["Asset number", asset.assetCode],
    ["Manufacturer", asset.manufacturer],
    ["Model", asset.model],
    ["Serial number", asset.serialNumber],
    ["Status", asset.status.replace(/^./, (letter) => letter.toUpperCase())],
    ...("assignedTo" in asset ? [["Assigned to", asset.assignedTo?.fullName ?? "Unassigned"]] : []),
  ].filter(([, value]) => value);

  return (
    <main className={styles.page}>
      <nav className={styles.navigation} aria-label="Devices">
        <Link href={canManageAssets ? "/?view=people&tab=assets" : "/?view=people"} className={styles.back}>
          <ArrowLeft size={18} aria-hidden="true" />{canManageAssets ? "Devices" : "People"}
        </Link>
        <ScanAssetButton className={styles.button} />
      </nav>
      <article className={styles.card}>
        <header className={styles.heading}><Laptop size={26} aria-hidden="true" /><h1>{type}</h1></header>
        <dl className={styles.details}>
          {fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      </article>
    </main>
  );
}
