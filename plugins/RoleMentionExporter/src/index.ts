import { findByProps, findByStoreName } from "@vendetta/metro";
import { clipboard, React, ReactNative as RN } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const { FormDivider, FormRow, FormSection, FormText } = Forms;

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const GuildStore = findByStoreName("GuildStore");
const GuildRoleStore = findByStoreName("GuildRoleStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const GuildMemberCountStore = findByStoreName("GuildMemberCountStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");

const PICKER_KEY = "RoleMentionExporterRolePicker";
const INJECTED_KEY = "role-mention-exporter-button-v2";
const BUTTON_TITLE = "Copy members by role";
const PLUGIN_TAG = "[RoleMentionExporter]";
const SERVER_MENU_LABELS = [
    "mark as read",
    "notifications",
    "more options",
];

const EXCLUDED_SHEET_WORDS = [
    "member",
    "user",
    "channel",
    "message",
    "thread",
    "invite",
    "rolementionexporter",
];

type DiscordRole = {
    id: string;
    name: string;
    color?: number;
    position?: number;
};

type DiscordMember = {
    userId?: string;
    user_id?: string;
    user?: { id?: string };
    roles?: string[];
    roleIds?: string[];
    role_ids?: string[];
};

type SheetContext = {
    key: unknown;
    openProps: any;
};

type InjectionResult = {
    tree: any;
    injected: boolean;
};
let patchedSheetModules = new WeakMap<object, () => void>();
let sheetContexts = new WeakMap<object, SheetContext>();
const moduleUnpatches = new Set<() => void>();
const warnedSheetKeys = new Set<string>();

let unpatchOpenLazy: (() => void) | undefined;

function log(...args: any[]) {
    console.log(PLUGIN_TAG, ...args);
}

function warn(...args: any[]) {
    console.warn(PLUGIN_TAG, ...args);
}

function closeSheet(key?: string) {
    try {
        LazyActionSheet?.hideActionSheet?.(key);
    } catch {
        try {
            LazyActionSheet?.hideActionSheet?.();
        } catch {}
    }
}

function normalizeText(value: unknown): string {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9@]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d{15,22}$/.test(value);
}

function getAllGuilds(): any[] {
    try {
        const raw = GuildStore?.getGuilds?.() ?? {};
        return Array.isArray(raw) ? raw : Object.values(raw);
    } catch {
        return [];
    }
}

function isKnownGuildId(value: unknown): value is string {
    if (!isSnowflake(value)) return false;
    try {
        return Boolean(GuildStore?.getGuild?.(value));
    } catch {
        return false;
    }
}

function findGuildIdDeep(value: any, maxDepth = 6): string | undefined {
    const seen = new Set<any>();
    const priorityKeys = [
        "guildId",
        "guild_id",
        "guildID",
        "guild",
        "channel",
        "id",
    ];

    function visit(current: any, depth: number): string | undefined {
        if (depth > maxDepth || current == null) return undefined;
        if (isKnownGuildId(current)) return current;
        if (typeof current !== "object" || seen.has(current)) return undefined;
        seen.add(current);

        for (const key of priorityKeys) {
            if (!(key in current)) continue;
            const found = visit(current[key], depth + 1);
            if (found) return found;
        }

        if (Array.isArray(current)) {
            for (const item of current) {
                const found = visit(item, depth + 1);
                if (found) return found;
            }
            return undefined;
        }

        for (const [key, nested] of Object.entries(current)) {
            if (priorityKeys.includes(key)) continue;
            if (key === "_owner" || key === "ref" || key === "type") continue;
            const found = visit(nested, depth + 1);
            if (found) return found;
        }

        return undefined;
    }

    return visit(value, 0);
}

function collectVisibleStrings(value: any, limit = 250): string[] {
    const strings: string[] = [];
    const seen = new Set<any>();

    function visit(current: any, depth: number) {
        if (strings.length >= limit || depth > 12 || current == null) return;

        if (typeof current === "string") {
            const trimmed = current.trim();
            if (trimmed) strings.push(trimmed);
            return;
        }

        if (typeof current === "number" || typeof current === "boolean" || typeof current === "function") {
            return;
        }

        if (typeof current !== "object" || seen.has(current)) return;
        seen.add(current);

        if (Array.isArray(current)) {
            for (const item of current) visit(item, depth + 1);
            return;
        }

        if (React.isValidElement(current)) {
            const props = current.props ?? {};
            for (const [key, nested] of Object.entries(props)) {
                if (key === "style" || key === "onPress" || key === "onLongPress" || key === "icon") continue;
                visit(nested, depth + 1);
            }
            return;
        }

        for (const key of ["defaultMessage", "message", "label", "text", "title", "content", "children"]) {
            if (key in current) visit(current[key], depth + 1);
        }
    }

    visit(value, 0);
    return strings;
}

function resolveGuildId(openProps: any, renderArgs: any[], tree: any): string | undefined {
    const direct = findGuildIdDeep(openProps) ?? findGuildIdDeep(renderArgs?.[0]);
    if (direct) return direct;

    const visibleStrings = collectVisibleStrings(tree);
    const normalizedVisible = visibleStrings.map(normalizeText).filter(Boolean);
    const nameMatches = getAllGuilds().filter(guild => {
        const guildName = normalizeText(guild?.name);
        if (!guildName) return false;
        return normalizedVisible.some(text => text === guildName || text.startsWith(`${guildName} `));
    });

    if (nameMatches.length === 1 && isKnownGuildId(nameMatches[0]?.id)) {
        return nameMatches[0].id;
    }

    try {
        const selected = SelectedGuildStore?.getGuildId?.()
            ?? SelectedGuildStore?.getLastSelectedGuildId?.();
        if (isKnownGuildId(selected)) return selected;
    } catch {}

    return undefined;
}

function isPotentialGuildSheetKey(key: unknown): boolean {
    const normalized = normalizeText(key);
    if (!normalized) return false;
    if (EXCLUDED_SHEET_WORDS.some(word => normalized.includes(word))) return false;
    return normalized.includes("guild") || normalized.includes("server");
}

function treeLooksLikeServerMenu(tree: any): boolean {
    const text = normalizeText(collectVisibleStrings(tree).join(" | "));
    const matches = SERVER_MENU_LABELS.filter(label => text.includes(label)).length;
    return matches >= 2;
}

function normalizeMembers(raw: unknown): DiscordMember[] {
    if (Array.isArray(raw)) return raw as DiscordMember[];
    if (raw && typeof raw === "object") return Object.values(raw) as DiscordMember[];
    return [];
}

function getCachedMembers(guildId: string): DiscordMember[] {
    const getters = [
        "getMembers",
        "getMutableGuildMembers",
        "getGuildMembers",
    ];

    for (const getter of getters) {
        try {
            const raw = GuildMemberStore?.[getter]?.(guildId);
            const members = normalizeMembers(raw);
            if (members.length) return members;
        } catch {}
    }

    return [];
}

function getMemberId(member: DiscordMember): string | undefined {
    return member?.userId ?? member?.user_id ?? member?.user?.id;
}

function getMemberRoleIds(member: DiscordMember): string[] {
    const roles = member?.roles ?? member?.roleIds ?? member?.role_ids;
    return Array.isArray(roles) ? roles : [];
}

function getGuildRoles(guildId: string): DiscordRole[] {
    let rawRoles: unknown;

    try {
        rawRoles = GuildRoleStore?.getRoles?.(guildId);
    } catch {}

    if (!rawRoles) {
        try {
            const guild = GuildStore?.getGuild?.(guildId);
            rawRoles = guild?.roles ?? guild?.getRoles?.();
        } catch {}
    }

    const roles = (Array.isArray(rawRoles) ? rawRoles : Object.values(rawRoles ?? {})) as DiscordRole[];

    return roles
        .filter(role => role?.id && role?.name)
        .sort((a, b) => {
            if (a.id === guildId) return 1;
            if (b.id === guildId) return -1;
            return (b.position ?? 0) - (a.position ?? 0);
        });
}

function getKnownGuildMemberCount(guildId: string): number | undefined {
    try {
        const count = GuildMemberCountStore?.getMemberCount?.(guildId)
            ?? GuildMemberCountStore?.getGuildMemberCount?.(guildId)
            ?? GuildStore?.getGuild?.(guildId)?.memberCount;
        return typeof count === "number" ? count : undefined;
    } catch {
        return undefined;
    }
}

function memberHasRole(member: DiscordMember, roleId: string, guildId: string): boolean {
    if (roleId === guildId) return true;
    return getMemberRoleIds(member).includes(roleId);
}

function getRoleMemberIds(guildId: string, roleId: string): string[] {
    return Array.from(new Set(
        getCachedMembers(guildId)
            .filter(member => memberHasRole(member, roleId, guildId))
            .map(getMemberId)
            .filter((id): id is string => Boolean(id)),
    ));
}

function copyRoleMembers(guildId: string, role: DiscordRole) {
    const cachedMembers = getCachedMembers(guildId);
    const ids = Array.from(new Set(
        cachedMembers
            .filter(member => memberHasRole(member, role.id, guildId))
            .map(getMemberId)
            .filter((id): id is string => Boolean(id)),
    ));

    if (!ids.length) {
        showToast(
            `No loaded members found with @${role.name}. Open the member list and scroll, then try again.`,
            getAssetIDByName("Small") ?? undefined,
        );
        return;
    }

    clipboard.setString(ids.map(id => `<@${id}>`).join(" "));
    closeSheet(PICKER_KEY);

    const knownTotal = getKnownGuildMemberCount(guildId);
    const cacheWarning = knownTotal && cachedMembers.length < knownTotal
        ? ` Discord has ${cachedMembers.length}/${knownTotal} members loaded, so the result may be incomplete.`
        : "";

    showToast(
        `Copied ${ids.length} mention${ids.length === 1 ? "" : "s"} from @${role.name}.${cacheWarning}`,
        getAssetIDByName("CopyIcon") ?? undefined,
    );
}
function RolePickerSheet({ guildId }: { guildId: string }) {
    const [query, setQuery] = React.useState("");
    const roles = getGuildRoles(guildId);
    const cachedMembers = getCachedMembers(guildId);
    const cachedCount = cachedMembers.length;
    const knownTotal = getKnownGuildMemberCount(guildId);
    const normalizedQuery = normalizeText(query);

    const filteredRoles = roles.filter(role =>
        !normalizedQuery || normalizeText(role.name).includes(normalizedQuery),
    );

    return React.createElement(
        RN.View,
        { style: { maxHeight: 660, paddingBottom: 16 } },
        React.createElement(
            RN.ScrollView,
            { keyboardShouldPersistTaps: "handled" },
            React.createElement(
                FormSection,
                { title: "COPY MEMBERS BY ROLE" },
                React.createElement(
                    FormText,
                    null,
                    knownTotal && cachedCount < knownTotal
                        ? `Discord currently has ${cachedCount} of about ${knownTotal} server members loaded. Open and scroll the member list first if you need the most complete result.`
                        : `${cachedCount} server members are loaded. Pick a role to copy its members as <@user_id> mentions.`,
                ),
                React.createElement(
                    RN.View,
                    { style: { paddingHorizontal: 16, paddingVertical: 10 } },
                    React.createElement(RN.TextInput, {
                        value: query,
                        onChangeText: setQuery,
                        placeholder: "Search roles",
                        placeholderTextColor: "#8E9297",
                        autoCapitalize: "none",
                        autoCorrect: false,
                        style: {
                            minHeight: 44,
                            borderRadius: 8,
                            paddingHorizontal: 12,
                            color: "#FFFFFF",
                            backgroundColor: "rgba(0, 0, 0, 0.22)",
                            fontSize: 16,
                        },
                    }),
                ),
                React.createElement(FormDivider, null),
                ...(filteredRoles.length
                    ? filteredRoles.flatMap((role, index) => {
                        const count = role.id === guildId
                            ? cachedCount
                            : getRoleMemberIds(guildId, role.id).length;
                        const row = React.createElement(FormRow, {
                            key: role.id,
                            label: role.name,
                            subLabel: `${count} loaded member${count === 1 ? "" : "s"}${role.id === guildId ? " (@everyone)" : ""}`,
                            onPress: () => copyRoleMembers(guildId, role),
                        });
                        return index === filteredRoles.length - 1
                            ? [row]
                            : [row, React.createElement(FormDivider, { key: `${role.id}-divider` })];
                    })
                    : [React.createElement(FormText, { key: "no-results" }, "No roles match that search.")]),
            ),
        ),
    );
}

function openRolePicker(guildId: string) {
    closeSheet();
    setTimeout(() => {
        try {
            LazyActionSheet.openLazy(
                Promise.resolve({ default: RolePickerSheet }),
                PICKER_KEY,
                { guildId },
            );
        } catch (error) {
            warn("Failed to open role picker", error);
            showToast("Role Mention Exporter could not open the role picker.");
        }
    }, 120);
}

function elementText(element: any): string {
    return normalizeText(collectVisibleStrings(element?.props).join(" "));
}

function collectPressableElements(tree: any): any[] {
    const results: any[] = [];
    const seen = new Set<any>();

    function visit(current: any, depth: number) {
        if (depth > 18 || current == null) return;
        if (typeof current !== "object" || seen.has(current)) return;
        seen.add(current);

        if (Array.isArray(current)) {
            for (const child of current) visit(child, depth + 1);
            return;
        }

        if (React.isValidElement(current)) {
            const props = current.props ?? {};
            if (typeof props.onPress === "function") results.push(current);
            for (const [key, nested] of Object.entries(props)) {
                if (key === "style" || key === "onPress" || key === "onLongPress" || key === "icon") continue;
                visit(nested, depth + 1);
            }
            return;
        }

        for (const [key, nested] of Object.entries(current)) {
            if (key === "_owner" || key === "ref" || key === "type") continue;
            visit(nested, depth + 1);
        }
    }

    visit(tree, 0);
    return results;
}

function isInjectedElement(element: any): boolean {
    return element?.key === INJECTED_KEY
        || element?.props?.roleMentionExporterInjected === true;
}

function findTemplateRow(tree: any): any | undefined {
    const pressables = collectPressableElements(tree).filter(element => !isInjectedElement(element));

    const scored = pressables
        .map(element => {
            const text = elementText(element);
            let score = 0;
            if (text.includes("more options")) score = 300;
            else if (text.includes("notifications")) score = 250;
            else if (text.includes("mark as read")) score = 200;
            else if (text) score = 10;
            return { element, score };
        })
        .sort((a, b) => b.score - a.score);

    return scored[0]?.score ? scored[0].element : undefined;
}
function containsServerMenuLabel(value: any): boolean {
    const text = normalizeText(collectVisibleStrings(value, 40).join(" "));
    return SERVER_MENU_LABELS.some(label => text.includes(label));
}

function replaceServerMenuLabel(value: any, replacement: string, depth = 0): { value: any; replaced: boolean } {
    if (depth > 10 || value == null) return { value, replaced: false };

    if (typeof value === "string") {
        return containsServerMenuLabel(value)
            ? { value: replacement, replaced: true }
            : { value, replaced: false };
    }

    if (Array.isArray(value)) {
        let replaced = false;
        const next = value.map(item => {
            if (replaced) return item;
            const result = replaceServerMenuLabel(item, replacement, depth + 1);
            replaced = result.replaced;
            return result.value;
        });
        return { value: replaced ? next : value, replaced };
    }

    if (typeof value !== "object") return { value, replaced: false };

    if (React.isValidElement(value)) {
        const result = replaceLabelsInProps(value.props, replacement, depth + 1);
        return result.replaced
            ? { value: React.cloneElement(value, result.props), replaced: true }
            : { value, replaced: false };
    }

    for (const key of ["defaultMessage", "message", "label", "text", "title", "content", "children"]) {
        if (!(key in value)) continue;
        const result = replaceServerMenuLabel(value[key], replacement, depth + 1);
        if (result.replaced) {
            return {
                value: { ...value, [key]: result.value },
                replaced: true,
            };
        }
    }

    return { value, replaced: false };
}

function replaceLabelsInProps(props: any, replacement: string, depth = 0): { props: any; replaced: boolean } {
    const nextProps = { ...props };
    let replaced = false;

    for (const key of ["label", "text", "title", "message", "children", "subtitle", "subLabel"]) {
        if (!(key in props)) continue;
        const result = replaceServerMenuLabel(props[key], replacement, depth + 1);
        if (result.replaced) {
            nextProps[key] = result.value;
            replaced = true;
        }
    }

    // Different Discord builds read different label props. Extra string props are
    // ignored by components that do not use them, but give us a stable fallback.
    nextProps.label = replacement;
    nextProps.text = replacement;
    nextProps.title = replacement;

    return { props: nextProps, replaced };
}

function makeInjectedRow(template: any, guildId: string) {
    const replaced = replaceLabelsInProps(template.props ?? {}, BUTTON_TITLE);

    return React.cloneElement(template, {
        ...replaced.props,
        key: INJECTED_KEY,
        roleMentionExporterInjected: true,
        onPress: () => openRolePicker(guildId),
    });
}

function findContainingArray(root: any, target: any): any[] | undefined {
    const seen = new Set<any>();
    function visit(current: any, depth: number): any[] | undefined {
        if (depth > 18 || current == null || typeof current !== "object") return undefined;
        if (seen.has(current)) return undefined;
        seen.add(current);

        if (Array.isArray(current)) {
            if (current.includes(target)) return current;
            for (const child of current) {
                const found = visit(child, depth + 1);
                if (found) return found;
            }
            return undefined;
        }

        if (React.isValidElement(current)) {
            const props = current.props ?? {};
            for (const [key, nested] of Object.entries(props)) {
                if (key === "style" || key === "onPress" || key === "onLongPress" || key === "icon") continue;
                const found = visit(nested, depth + 1);
                if (found) return found;
            }
            return undefined;
        }

        for (const [key, nested] of Object.entries(current)) {
            if (key === "_owner" || key === "ref" || key === "type") continue;
            const found = visit(nested, depth + 1);
            if (found) return found;
        }

        return undefined;
    }

    return visit(root, 0);
}

function insertBeforeTargetImmutable(root: any, target: any, injected: any): InjectionResult {
    const seen = new Set<any>();

    function visit(current: any, depth: number): InjectionResult {
        if (depth > 18 || current == null || typeof current !== "object") {
            return { tree: current, injected: false };
        }
        if (seen.has(current)) return { tree: current, injected: false };
        seen.add(current);

        if (Array.isArray(current)) {
            const directIndex = current.indexOf(target);
            if (directIndex >= 0) {
                return {
                    tree: [
                        ...current.slice(0, directIndex),
                        injected,
                        ...current.slice(directIndex),
                    ],
                    injected: true,
                };
            }

            for (let index = 0; index < current.length; index++) {
                const result = visit(current[index], depth + 1);
                if (result.injected) {
                    const next = current.slice();
                    next[index] = result.tree;
                    return { tree: next, injected: true };
                }
            }
            return { tree: current, injected: false };
        }

        if (React.isValidElement(current)) {
            const props = current.props ?? {};
            for (const [key, nested] of Object.entries(props)) {
                if (key === "style" || key === "onPress" || key === "onLongPress" || key === "icon") continue;
                const result = visit(nested, depth + 1);
                if (result.injected) {
                    return {
                        tree: React.cloneElement(current, { [key]: result.tree }),
                        injected: true,
                    };
                }
            }
            return { tree: current, injected: false };
        }

        for (const key of ["children", "content", "items"]) {
            if (!(key in current)) continue;
            const result = visit(current[key], depth + 1);
            if (result.injected) {
                return {
                    tree: { ...current, [key]: result.tree },
                    injected: true,
                };
            }
        }

        return { tree: current, injected: false };
    }

    return visit(root, 0);
}

function injectButton(tree: any, guildId: string): InjectionResult {
    if (collectPressableElements(tree).some(isInjectedElement)) {
        return { tree, injected: true };
    }

    const template = findTemplateRow(tree);
    if (!template) return { tree, injected: false };

    const injected = makeInjectedRow(template, guildId);
    const container = findContainingArray(tree, template);

    if (container && !Object.isFrozen(container)) {
        const index = container.indexOf(template);
        if (index >= 0) {
            container.splice(index, 0, injected);
            return { tree, injected: true };
        }
    }

    return insertBeforeTargetImmutable(tree, template, injected);
}

function patchResolvedSheet(module: any, context: SheetContext) {
    if (!module?.default || (typeof module !== "object" && typeof module !== "function")) return;

    sheetContexts.set(module, context);
    if (patchedSheetModules.has(module)) return;

    const unpatch = after("default", module, (renderArgs, tree) => {
        const latestContext = sheetContexts.get(module) ?? context;
        const keyMatches = isPotentialGuildSheetKey(latestContext.key);
        const treeMatches = treeLooksLikeServerMenu(tree);

        if (!keyMatches && !treeMatches) return;

        const guildId = resolveGuildId(latestContext.openProps, renderArgs, tree);
        if (!guildId) {
            const keyText = String(latestContext.key ?? "unknown");
            if (!warnedSheetKeys.has(keyText)) {
                warnedSheetKeys.add(keyText);
                warn(`Found a possible server menu (${keyText}) but could not resolve its guild ID.`);
            }
            return;
        }
        const result = injectButton(tree, guildId);
        if (result.injected) {
            log(`Injected into ${String(latestContext.key ?? "unknown")} for guild ${guildId}`);
            return result.tree;
        }

        const keyText = String(latestContext.key ?? "unknown");
        if (!warnedSheetKeys.has(keyText)) {
            warnedSheetKeys.add(keyText);
            warn(`Found server menu ${keyText}, but no compatible pressable row was found.`);
            showToast("Role exporter found the server menu but could not add its button. Check Revenge debug logs.");
        }
    });

    patchedSheetModules.set(module, unpatch);
    moduleUnpatches.add(unpatch);
}

function observeSheet(componentPromise: any, key: unknown, openProps: any) {
    if (!componentPromise?.then) return;
    componentPromise
        .then((module: any) => patchResolvedSheet(module, { key, openProps }))
        .catch((error: any) => warn("Could not inspect action sheet", key, error));
}

function onLoad() {
    if (!LazyActionSheet?.openLazy || !GuildStore || !GuildMemberStore) {
        showToast("Role Mention Exporter could not find Discord's required modules.");
        return;
    }

    unpatchOpenLazy = before(
        "openLazy",
        LazyActionSheet,
        ([componentPromise, key, openProps]) => {
            // Current Revenge-compatible plugins still discover action sheets through
            // openLazy. We inspect every sheet and only inject when its key or rendered
            // labels identify the server long-press menu.
            observeSheet(componentPromise, key, openProps);
        },
    );

    log("Loaded. Long-press a server and look for 'Copy members by role'.");
    showToast("Role Mention Exporter v2 loaded");
}

function onUnload() {
    unpatchOpenLazy?.();
    unpatchOpenLazy = undefined;

    for (const unpatch of moduleUnpatches) {
        try {
            unpatch();
        } catch {}
    }
    moduleUnpatches.clear();
    patchedSheetModules = new WeakMap<object, () => void>();
    sheetContexts = new WeakMap<object, SheetContext>();
    warnedSheetKeys.clear();
    closeSheet(PICKER_KEY);
}
export default { onLoad, onUnload };
            const buttons = findButtonArray(tree);
            if (!buttons || buttons.some((item: any) => item?.key === INJECTED_KEY)) return;

            const template = buttons.find((item: any) => typeof item?.props?.onPress === "function");
            if (!template) return;

            const title = "Copy members by role";
            const injected = React.cloneElement(template, {
                key: INJECTED_KEY,
                message: title,
                label: title,
                text: title,
                onPress: () => openRolePicker(guildId),
                // Let Discord render its normal row. An icon is intentionally omitted
                // because asset names vary across Discord versions.
                icon: getAssetIDByName("CopyIcon") ?? template.props.icon,
            });

            // Put it near the bottom, before destructive actions in most builds.
            buttons.splice(Math.max(buttons.length - 1, 0), 0, injected);
        });
    }).catch(() => {});
}

let unpatchGuildSheet: (() => void) | undefined;

function onLoad() {
    if (!LazyActionSheet?.openLazy || !GuildStore || !GuildMemberStore) {
        showToast("Role Mention Exporter could not find Discord's required modules.");
        return;
    }

    unpatchGuildSheet = before(
        "openLazy",
        LazyActionSheet,
        ([componentPromise, key, props]) => {
            if (!isGuildLongPressSheet(key, props)) return;
            const guildId = getGuildId(props);
            if (!guildId || !componentPromise?.then) return;
            injectGuildButton(componentPromise, guildId);
        },
    );
}

function onUnload() {
    unpatchGuildSheet?.();
    unpatchGuildSheet = undefined;
    closeSheet(PICKER_KEY);
}

export default { onLoad, onUnload };
