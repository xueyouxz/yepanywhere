import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useVersion } from "../../hooks/useVersion";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { useI18n } from "../../i18n";
import {
  getDevelopmentCategory,
  getEmulatorCategory,
  getSettingsCategories,
} from "../../i18n-settings";
import { MainContent, useNavigationLayout } from "../../layouts";
import { AboutSettings } from "./AboutSettings";
import { AgentContextSettings } from "./AgentContextSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { DevelopmentSettings } from "./DevelopmentSettings";
import { DevicesSettings } from "./DevicesSettings";
import { EmulatorSettings } from "./EmulatorSettings";
import { LifecycleWebhooksSettings } from "./LifecycleWebhooksSettings";
import { LocalAccessSettings } from "./LocalAccessSettings";
import { MessageDeliverySettings } from "./MessageDeliverySettings";
import { ModelSettings } from "./ModelSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { RemoteExecutorsSettings } from "./RemoteExecutorsSettings";
import { SettingsCategoryIcon } from "./SettingsCategoryIcons";
import {
  SettingsUndoProvider,
  useSettingsUndoRegistration,
} from "./SettingsUndoContext";
import { SpeechSettings } from "./SpeechSettings";
import { ToolbarSettings } from "./ToolbarSettings";
import type { SettingsCategory } from "./types";

// Map category IDs to their components
const CATEGORY_COMPONENTS: Record<string, React.ComponentType> = {
  appearance: AppearanceSettings,
  toolbar: ToolbarSettings,
  model: ModelSettings,
  "message-delivery": MessageDeliverySettings,
  "agent-context": AgentContextSettings,
  notifications: NotificationsSettings,
  webhooks: LifecycleWebhooksSettings,
  devices: DevicesSettings,
  "local-access": LocalAccessSettings,
  remote: RemoteAccessSettings,
  providers: ProvidersSettings,
  speech: SpeechSettings,
  "remote-executors": RemoteExecutorsSettings,
  emulator: EmulatorSettings,
  about: AboutSettings,
  development: DevelopmentSettings,
};

export const SETTINGS_TWO_COLUMN_BREAKPOINT = 720;

export function shouldUseSettingsTwoColumn(viewportWidth: number): boolean {
  return viewportWidth >= SETTINGS_TWO_COLUMN_BREAKPOINT;
}

interface SettingsCategoryItemProps {
  category: SettingsCategory;
  isActive: boolean;
  onClick: () => void;
}

function SettingsCategoryItem({
  category,
  isActive,
  onClick,
}: SettingsCategoryItemProps) {
  return (
    <button
      type="button"
      className={`settings-category-item ${isActive ? "active" : ""}`}
      onClick={onClick}
    >
      <SettingsCategoryIcon id={category.id} />
      <div className="settings-category-text">
        <span className="settings-category-label">{category.label}</span>
        <span className="settings-category-description">
          {category.description}
        </span>
      </div>
      <span className="settings-category-chevron">›</span>
    </button>
  );
}

export function SettingsLayout() {
  const { t } = useI18n();
  const { category } = useParams<{ category?: string }>();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const viewportWidth = useViewportWidth();
  const useTwoColumnSettings = shouldUseSettingsTwoColumn(viewportWidth);
  const { isManualReloadMode } = useReloadNotifications();
  const { version: versionInfo } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];
  const {
    registration: undoRegistration,
    setRegistration: setUndoRegistration,
  } = useSettingsUndoRegistration();

  // Build the list of categories, conditionally including emulator and dev
  const categories: SettingsCategory[] = [
    ...getSettingsCategories((key) => t(key as never)),
  ];
  if (
    capabilities.includes("deviceBridge") ||
    capabilities.includes("deviceBridge-download") ||
    capabilities.includes("deviceBridge-available")
  ) {
    // Insert before "about"
    const aboutIndex = categories.findIndex((c) => c.id === "about");
    categories.splice(
      aboutIndex >= 0 ? aboutIndex : categories.length,
      0,
      getEmulatorCategory((key) => t(key as never)),
    );
  }
  if (isManualReloadMode) {
    categories.push(getDevelopmentCategory((key) => t(key as never)));
  }

  // Two-column settings can fit before the persistent app sidebar can.
  const effectiveCategory =
    category || (useTwoColumnSettings ? categories[0]?.id : undefined);

  const handleCategoryClick = (categoryId: string) => {
    navigate(`${basePath}/settings/${categoryId}`);
  };

  const handleBack = () => {
    navigate(`${basePath}/settings`);
  };

  // Get the component for the current category
  const CategoryComponent = effectiveCategory
    ? CATEGORY_COMPONENTS[effectiveCategory]
    : null;

  const canUndoSettingsChange = undoRegistration?.canUndo ?? false;

  // The single per-pane Undo affordance: panes register via useSettingsUndo.
  // Keep the button's header footprint even while hidden so settings rows do
  // not shift when a field first becomes undoable.
  const undoButton = (
    <button
      type="button"
      className="settings-button"
      onClick={() => void undoRegistration?.undo()}
      title={t("settingsUndoChangesTooltip")}
      disabled={!canUndoSettingsChange}
      aria-hidden={!canUndoSettingsChange}
      tabIndex={canUndoSettingsChange ? 0 : -1}
      style={{ visibility: canUndoSettingsChange ? "visible" : "hidden" }}
    >
      {t("settingsUndoChanges")}
    </button>
  );

  // Narrow settings: category list OR category detail (not both)
  if (!useTwoColumnSettings) {
    if (!category) {
      // Show category list
      return (
        <MainContent isWideScreen={isWideScreen}>
          <PageHeader
            title={t("pageTitleSettings")}
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main className="page-scroll-container">
            <div className="page-content-inner">
              <div className="settings-category-list">
                {categories.map((cat) => (
                  <SettingsCategoryItem
                    key={cat.id}
                    category={cat}
                    isActive={false}
                    onClick={() => handleCategoryClick(cat.id)}
                  />
                ))}
              </div>
            </div>
          </main>
        </MainContent>
      );
    }

    // Show category detail with back button
    const currentCategory = categories.find((c) => c.id === category);
    return (
      <MainContent isWideScreen={isWideScreen}>
        <PageHeader
          title={currentCategory?.label || t("pageTitleSettings")}
          onOpenSidebar={openSidebar}
          showBack
          onBack={handleBack}
          actions={undoButton}
        />
        <main className="page-scroll-container">
          <div className="page-content-inner">
            <SettingsUndoProvider value={setUndoRegistration}>
              {CategoryComponent && <CategoryComponent />}
            </SettingsUndoProvider>
          </div>
        </main>
      </MainContent>
    );
  }

  // Desktop: two-column layout with category list on left, content on right
  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader
        title={t("pageTitleSettings")}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
        actions={undoButton}
      />
      <main className="page-scroll-container">
        <div className="settings-two-column">
          <nav className="settings-category-nav">
            <div className="settings-category-list">
              {categories.map((cat) => (
                <SettingsCategoryItem
                  key={cat.id}
                  category={cat}
                  isActive={effectiveCategory === cat.id}
                  onClick={() => handleCategoryClick(cat.id)}
                />
              ))}
            </div>
          </nav>
          <div className="settings-content-panel">
            <SettingsUndoProvider value={setUndoRegistration}>
              {CategoryComponent && <CategoryComponent />}
            </SettingsUndoProvider>
          </div>
        </div>
      </main>
    </MainContent>
  );
}
