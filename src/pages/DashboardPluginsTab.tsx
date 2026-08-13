/**
 * Plugins, on the editor's own dashboard.
 *
 * The dashboard is where a user manages things that outlive a single project —
 * projects, assets, renders — and installed plugins belong with them. Before
 * this the only route to them was inside an open editor, which meant a user
 * with no project open could not see what they had installed.
 *
 * It renders `PluginsList`, the same component the editor's left rail uses,
 * rather than a dashboard-shaped copy. Two lists of installed plugins that
 * drift apart is the outcome this whole surface has been arranged to avoid, and
 * a second one here would drift fastest — it is the one nobody looks at while
 * developing a plugin. Search, install-from-disk and paging therefore behave
 * identically in both places, because they ARE both places.
 *
 * So the page itself is only two things: the list, and the publisher flow that
 * has no room in a dock column.
 */

import { useState } from 'react';
import { PluginsList } from '@layout/Plugins/PluginsList';
import { MyPluginsSection } from '@layout/Plugins/MyPluginsSection';
import { Modal } from '@components/Modal';
import styles from './DashboardPage.module.css';

const SR_HEADING_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function DashboardPluginsTab(): JSX.Element {
  const [publishModalOpen, setPublishModalOpen] = useState(false);

  return (
    <>
      <h2 style={SR_HEADING_STYLE}>Publishing</h2>

      <div className={styles.pluginsPanelHost}>
        <PluginsList onPublishPlugin={() => setPublishModalOpen(true)} />
      </div>

      <Modal
        open={publishModalOpen}
        onClose={() => setPublishModalOpen(false)}
        title="Publisher Portal & Package Signing"
        description="Claim publisher namespace, manage signing keys, and publish custom plugin packages."
        size="lg"
      >
        <div className={styles.modalPublishContainer}>
          <MyPluginsSection />
        </div>
      </Modal>
    </>
  );
}
