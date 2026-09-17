import { ArrowUpRight, FileText, Paperclip, Trash2 } from "lucide-react";
import { useState } from "react";
import type { LeaveAttachment } from "@/app/leave/actions";
import { formatFileSize } from "@/lib/leave-attachments";
import styles from "@/components/leave-demo.module.css";

export function AttachmentList({ attachments, busy = false, onDelete }: { attachments: LeaveAttachment[]; busy?: boolean; onDelete?: (attachmentId: string) => Promise<void> }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  if (!attachments.length) return null;

  return <section className={styles.attachmentList} aria-label="Supporting files">
    <span><Paperclip aria-hidden="true" size={14} /> Supporting files</span>
    {attachments.map((attachment) => <div className={styles.attachmentItem} key={attachment.id}>
      <div className={styles.attachmentItemActions}>
        <a href={`/leave/attachments/${attachment.id}`}>
          <FileText aria-hidden="true" size={17} />
          <span><strong>{attachment.fileName}</strong><small>{formatFileSize(attachment.sizeBytes)} · Download</small></span>
          <ArrowUpRight aria-hidden="true" size={15} />
        </a>
        {attachment.canDelete && onDelete ? <button className={styles.attachmentDeleteButton} type="button" aria-label={`Delete ${attachment.fileName}`} aria-expanded={confirmDeleteId === attachment.id} onClick={() => setConfirmDeleteId(attachment.id)} disabled={busy} title="Delete file"><Trash2 aria-hidden="true" size={15} /><span>Delete</span></button> : null}
      </div>
      {attachment.canDelete && onDelete && confirmDeleteId === attachment.id ? <div className={styles.attachmentDeleteConfirm} role="group" aria-label={`Confirm deletion of ${attachment.fileName}`}>
        <span><strong>Delete this file?</strong><small>This cannot be undone.</small></span>
        <div>
          <button className={styles.attachmentDeleteKeepButton} type="button" onClick={() => setConfirmDeleteId(null)} disabled={busy}>Cancel</button>
          <button className={styles.attachmentDeleteConfirmButton} type="button" onClick={() => void onDelete(attachment.id)} disabled={busy}><Trash2 aria-hidden="true" size={14} />{busy ? "Deleting…" : "Delete"}</button>
        </div>
      </div> : null}
    </div>)}
  </section>;
}
