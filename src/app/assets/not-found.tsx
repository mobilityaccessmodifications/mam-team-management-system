import Link from "next/link";
import styles from "./asset-page.module.css";

export default function AssetNotFound() {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <h1>Device unavailable</h1>
        <p>This device is unavailable or you do not have access.</p>
        <Link href="/assets/scan" className={styles.button}>Scan another device</Link>
        <Link href="/?view=people" className={styles.back}>Back to People</Link>
      </section>
    </main>
  );
}
