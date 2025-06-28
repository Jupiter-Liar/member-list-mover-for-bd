/**
 * @name Member List Mover
 * @description Puts the member list after the channel sidebar
 * @version 1.0
 * @author JupiterLiar
 * @license CC BY SA
 * @donate https://buymeacoffee.com/jupiterliar
 * @website https://linktr.ee/jupiterliar
 * @source https://github.com/Jupiter-Liar/member-list-mover-for-bd/
 * @updateUrl https://raw.githubusercontent.com/Jupiter-Liar/member-list-mover-for-bd/refs/heads/main/MemberListMover.plugin.js
 */

module.exports = class MoveMembersWrap {
    // Constructor for the plugin class
    constructor() {
        this.observer = null; // MutationObserver for observing changes
        this.button = null; // The "Move" button element
        this.wrapperDiv = null; // Reference to the button's main wrapper div
        this.resizeHandle = null; // The resize handle element
        this.handleIndicator = null; // The inner div for the resize handle visual
        this.isMoved = false; // Flag to track if the layout has been "moved" by our script
        this.onResizeHandler = this.handleWindowResize.bind(this); // Bound handler for window resize
        this.animationFrameId = null; // To handle requestAnimationFrame for immediate execution
        this.failsafeIntervalId = null; // ID for the periodic failsafe check
        this.FAILSALE_INTERVAL_MS = 2000; // How often the failsafe interval runs (2 seconds)

        // BdApi specific properties for state persistence
        this.pluginId = "MemberListMover"; // Unique ID for your plugin for BdApi
        this.dataKey = "isMovedState"; // Key for the boolean state
        this.heightsDataKey = "listHeights"; // Key for saving height percentages

        // Resize properties
        this.sidebarHeightPercentage = 0.5; // Initial 50% for sidebar list height
        this.membersHeightPercentage = 0.5; // Initial 50% for members list height
        // Total vertical space the handle occupies in px (8px visual height + 2px top margin + 6px bottom margin = 16px)
        this.RESIZE_HANDLE_HEIGHT = 16;
        // Total vertical space the button wrapper occupies (6px height + 2px top margin = 8px)
        this.BUTTON_WRAPPER_HEIGHT = 8;
        // Combined fixed height for resize handle + button wrapper that will sit above scrollable content
        this.OUR_UI_HEIGHT_PX = this.RESIZE_HANDLE_HEIGHT + this.BUTTON_WRAPPER_HEIGHT;
        this.MIN_HEIGHT_PERCENTAGE = 0.05; // Minimum 5% for either list

        // Variables for drag functionality
        this.isDragging = false;
        this.initialMouseY = 0;
        this.initialSidebarHeightPercentage = 0;
        this.initialMembersHeightPercentage = 0;

        // Bound event handlers for clean removal
        this.onMouseMoveHandler = this.onMouseMove.bind(this);
        this.onMouseUpHandler = this.onMouseUp.bind(this);

        // Flag to prevent multiple resize listeners being added
        window.bdResizeListenerAdded = false;

        this.lastLayoutApplyTimestamp = 0; // Last time applyCurrentLayoutState was actually executed
        this.reapplyThrottleDelay = 100; // Minimum 100ms between reapplications (throttle period)
        this.reapplyTimeout = null; // To hold the setTimeout ID for throttling
        this.isThrottling = false; // New flag: true if currently in a throttle cooldown period
        this.pendingThrottleCall = false; // New flag: true if a call is pending after cooldown

        // New properties for handling member list absence
        this.memberListAbsenceTimer = null; // Timer ID for delayed check of member list absence
        this.ABSENCE_CHECK_DELAY_MS = 150; // Delay for checking if member list is truly absent

        // Control constants for logging
        this.masterLogs = false; // Master switch for all logs
        this.consoleLogs = false; // Enable/disable regular logs
        this.consoleWarnings = false; // Enable/disable warnings
        this.consoleErrors = false; // Enable/disable errors
    }

    // Helper to get formatted timestamp
    getTimestamp() {
        const now = new Date();
        return `[${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, "0")}]`;
    }

    // Custom logging functions
    _log(...args) {
        if (!this.consoleLogs && this.masterLogs) {
            return;
        }
        console.log(`${this.getTimestamp()} BetterDiscord:`, ...args);
    }

    _warn(...args) {
        if (!this.consoleWarnings && !this.masterLogs) {
            return;
        }
        console.warn(`${this.getTimestamp()} BetterDiscord:`, ...args);
    }

    _error(...args) {
        if (!this.consoleErrors && !this.masterLogs) {
            return;
        }
        console.error(`${this.getTimestamp()} BetterDiscord:`, ...args);
    }

    // This method is called when the plugin is enabled
    start() {
        this._log(`Member List Mover plugin started.`);

        // Load state using BdApi
        const savedState = BdApi.loadData(this.pluginId, this.dataKey);
        if (savedState !== null) {
            this.isMoved = savedState;
            this._log(`Loaded saved state: isMoved = ${this.isMoved}`);
        } else {
            this._log(`No saved state found. Starting with isMoved = false.`);
        }

        // Load height percentages
        const savedHeights = BdApi.loadData(this.pluginId, this.heightsDataKey);
        if (
            savedHeights &&
            typeof savedHeights.sidebar !== "undefined" &&
            typeof savedHeights.members !== "undefined"
        ) {
            this.sidebarHeightPercentage = savedHeights.sidebar;
            this.membersHeightPercentage = savedHeights.members;
            this._log(
                `Loaded saved heights: Sidebar = ${this.sidebarHeightPercentage.toFixed(3)}%, Members = ${this.membersHeightPercentage.toFixed(3)}%.`
            );
        } else {
            this._log(`No saved heights found. Using default 50/50.`);
        }

        // Setup the observer to monitor for DOM changes
        this.setupObserver();

        // Call applyCurrentLayoutState directly after loading state and setting up elements
        // This initial call will directly apply the layout.
        this.applyCurrentLayoutState();

        // Start the failsafe interval
        this.failsafeIntervalId = setInterval(() => {
            this.checkAndReapplyLayout();
        }, this.FAILSALE_INTERVAL_MS);
        this._log(`Failsafe interval started (every ${this.FAILSALE_INTERVAL_MS}ms).`);
    }

    // This method is called when the plugin is disabled
    stop() {
        this._log(`Member List Mover plugin stopped.`);
        try {
            // Disconnect the observer
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
                this._log(`MutationObserver disconnected during stop.`);
            }

            // Clear any pending animation frame or throttle timeout
            if (this.animationFrameId) {
                cancelAnimationFrame(this.animationFrameId);
                this.animationFrameId = null;
            }
            if (this.reapplyTimeout) {
                clearTimeout(this.reapplyTimeout);
                this.reapplyTimeout = null;
            }
            // Clear the failsafe interval
            if (this.failsafeIntervalId) {
                clearInterval(this.failsafeIntervalId);
                this.failsafeIntervalId = null;
                this._log(`Failsafe interval stopped.`);
            }
            // Clear any pending member list absence timer
            if (this.memberListAbsenceTimer) {
                clearTimeout(this.memberListAbsenceTimer);
                this.memberListAbsenceTimer = null;
                this._log(`Cleared member list absence timer during stop.`);
            }
        } catch (e) {
            this._error(`Error disconnecting/stopping during stop:`, e.message, e.stack);
        }

        // Remove the button and its wrappers if they exist for a clean shutdown
        const membersWrap = document.querySelector('[class*="membersWrap"]');
        const wrapperDiv = membersWrap ? membersWrap.querySelector("#bd-move-button-wrapper") : null;
        const resizeHandle = membersWrap ? membersWrap.querySelector("#bd-resize-handle") : null;

        if (wrapperDiv && wrapperDiv.parentNode) {
            wrapperDiv.parentNode.removeChild(wrapperDiv);
            this.button = null;
            this.wrapperDiv = null;
            this._log(`Move button wrapper removed during stop.`);
        }
        if (resizeHandle && resizeHandle.parentNode) {
            resizeHandle.parentNode.removeChild(resizeHandle);
            this.resizeHandle = null;
            this.handleIndicator = null;
            this._log(`Resize handle removed during stop.`);
        }

        // Remove the resize event listener
        window.removeEventListener("resize", this.onResizeHandler);
        window.bdResizeListenerAdded = false;
        // Also remove global mouse listeners for drag if they were active
        window.removeEventListener("mousemove", this.onMouseMoveHandler);
        window.removeEventListener("mouseup", this.onMouseUpHandler);
        this._log(`Resize and drag event listeners removed.`);

        this.applyOriginalLayoutStyles(); // Ensure Discord elements are reset
    }

    /**
     * Resets the applied CSS styles to the membersWrap, sidebarList, and membersListContainer elements.
     * This is called when the plugin is stopped or if the layout needs to revert.
     * It ensures Discord can regain full control over these elements.
     */
    applyOriginalLayoutStyles() {
        const membersWrap = document.querySelector('[class*="membersWrap"]');
        const sidebarList = document.querySelector('[class*="sidebarList"]');
        const membersListContainer = document.querySelector("#bd-members-list-container"); // Discord's content container

        // Use removeProperty to ensure clean removal of specific inline styles
        if (membersWrap) {
            membersWrap.style.removeProperty("position");
            membersWrap.style.removeProperty("width");
            membersWrap.style.removeProperty("height");
            membersWrap.style.removeProperty("left");
            membersWrap.style.removeProperty("top");
            membersWrap.style.removeProperty("transform");
            membersWrap.style.removeProperty("min-width");
            membersWrap.style.removeProperty("flex-direction");
            membersWrap.style.removeProperty("display");
            membersWrap.style.removeProperty("z-index"); // Ensure z-index is removed for membersWrap
            this._log(`MembersWrap layout styles reset (flex-direction and display now removed, z-index cleared).`);
        }
        if (sidebarList) {
            this._resetSidebarListStyles(); // Use the new helper for sidebar list
            this._log(`SidebarList styles reset via applyOriginalLayoutStyles.`);
        }
        if (membersListContainer) {
            // Reset Discord's content container height
            membersListContainer.style.removeProperty("height");
            membersListContainer.style.removeProperty("width");
            membersListContainer.style.removeProperty("overflow-y");
            this._log(`MembersListContainer styles reset.`);
        }

        // We don't hide them here; applyCurrentLayoutState handles visibility.
        // We only reset the isMoved state and update button visuals.
        if (this.wrapperDiv && this.subContainerDiv && this.button) {
            this.isMoved = false;
            this.updateButtonVisualState(this.button, this.wrapperDiv, this.subContainerDiv, false); // Pass false for original state
            this._log(`Button wrapper state reset (not removed from DOM), heights NOT reverted to 50/50.`);
        }
    }

    /**
     * Calculates and updates percentage values for sidebar and members heights,
     * then triggers the current layout state application.
     * This function is called on window resize and during drag operations.
     */
    handleWindowResize() {
        // Select the target elements for layout manipulation
        const membersWrap = document.querySelector('[class*="membersWrap"]');
        const sidebarList = document.querySelector('[class*="sidebarList"]');
        const userIDSection = document.querySelector('[class*="sidebarList"] ~ section');
        // membersListContainer can be null here, applyCurrentLayoutState handles it
        const membersListContainer = document.querySelector("#bd-members-list-container");

        if (!membersWrap || !sidebarList || !userIDSection) {
            // membersListContainer can be missing
            this._warn(`Required elements for layout calculation not found during resize. Skipping layout update.`);
            return;
        }

        let sidebarListRect = sidebarList.getBoundingClientRect();
        const userIDSectionRect = userIDSection.getBoundingClientRect();

        const totalColumnHeight = userIDSectionRect.top - sidebarListRect.top;
        const availableHeightForPanels = totalColumnHeight;

        if (availableHeightForPanels <= 0) {
            this._warn(`Available height for panels is zero or negative. Skipping layout update.`);
            return;
        }

        const calculatedSidebarHeight = availableHeightForPanels * this.sidebarHeightPercentage;
        const calculatedMembersTotalHeight = availableHeightForPanels * this.membersHeightPercentage;

        sidebarList.style.height = `${calculatedSidebarHeight}px`;
        sidebarList.style.paddingBottom = "0px";
        const sidebarNav = sidebarList.querySelector("nav");
        if (sidebarNav) {
            sidebarNav.style.paddingBottom = "0px";
        }

        // Recompute sidebarListRect AFTER its height is set to ensure accurate .bottom
        sidebarListRect = sidebarList.getBoundingClientRect();

        // Trigger the centralized layout application with the newly calculated values
        this.queueLayoutReapply(); // Use queueLayoutReapply for all external triggers

        this._log(`Layout recomputed and applied (CSS transformation).`);
    }

    /**
     * Applies the CSS styles for the "moved" layout state.
     * @param {HTMLElement} membersWrap
     * @param {HTMLElement} sidebarList
     * @param {HTMLElement | null} membersListContainer - Can be null
     * @param {number} calculatedSidebarHeight
     * @param {number} calculatedMembersTotalHeight
     * @param {DOMRect} sidebarListRect
     */
    applyMovedLayoutStyles(
        membersWrap,
        sidebarList,
        membersListContainer,
        calculatedSidebarHeight,
        calculatedMembersTotalHeight,
        sidebarListRect
    ) {
        this._log(`Applying MOVED layout styles.`);

        const remainingHeightForDiscordContent = calculatedMembersTotalHeight - this.OUR_UI_HEIGHT_PX;

        // Apply styles to membersWrap regardless of membersListContainer presence
        membersWrap.style.position = "fixed";
        membersWrap.style.width = `${sidebarListRect.width}px`;
        membersWrap.style.height = `${calculatedMembersTotalHeight}px`;
        membersWrap.style.left = `${sidebarListRect.left}px`;
        membersWrap.style.top = `${sidebarListRect.bottom}px`;
        membersWrap.style.transform = "translateX(0%)";
        membersWrap.style.removeProperty("z-index"); // Ensure z-index is explicitly removed for membersWrap
        membersWrap.style.minWidth = "unset";
        membersWrap.style.display = "flex";
        membersWrap.style.flexDirection = "column";

        sidebarList.style.height = `${calculatedSidebarHeight}px`;
        sidebarList.style.paddingBottom = "0px";
        const sidebarNav = sidebarList.querySelector("nav");
        if (sidebarNav) {
            sidebarNav.style.paddingBottom = "0px";
        }

        // Apply styles to membersListContainer only if it is present
        if (membersListContainer) {
            membersListContainer.style.height = `${Math.max(0, remainingHeightForDiscordContent)}px`;
            membersListContainer.style.width = "100%";
            membersListContainer.style.overflowY = "auto";
            this._log(`membersListContainer styles applied.`);
        } else {
            this._log(`membersListContainer not present, skipping its style application.`);
        }
        this._log(`MOVED layout styles processing completed.`);
    }

    /**
     * Centralized method to apply the current layout state (moved or original).
     * This method orchestrates element finding, parenting, and style application.
     */
    applyCurrentLayoutState() {
        this._log(`Entering applyCurrentLayoutState logic block.`);
        try {
            const membersWrap = document.querySelector('[class*="membersWrap"]');
            const sidebarList = document.querySelector('[class*="sidebarList"]');
            const userIDSection = document.querySelector('[class*="sidebarList"] ~ section');
            let membersListContainer = null; // Will be queried later, can be null initially

            if (!membersWrap) {
                this._warn(`applyCurrentLayoutState: membersWrap not found. Skipping application.`);
                return;
            }
            if (!sidebarList) {
                this._warn(`applyCurrentLayoutState: sidebarList not found. Skipping application.`);
                return;
            }
            if (!userIDSection) {
                this._warn(`applyCurrentLayoutState: userIDSection not found. Skipping application.`);
                return;
            }

            // Attempt to find membersListContainer
            membersListContainer = membersWrap.querySelector('[class*="members"]');
            if (membersListContainer) {
                membersListContainer.id = "bd-members-list-container";
                this._log(`Ensured ID "bd-members-list-container" on Discord\'s members content container.`);
            } else {
                this._warn(
                    `applyCurrentLayoutState: membersListContainer not found within membersWrap. It may appear later, applying primary styles first.`
                );
            }

            // Ensure our custom UI elements exist in memory. addMoveButton now only creates them.
            if (!this.button || !this.wrapperDiv || !this.resizeHandle) {
                this.addMoveButton();
                this._log(`applyCurrentLayoutState: Created custom UI elements in memory.`);
            }

            // Handle parenting and visibility based on isMoved state
            if (this.isMoved) {
                this._log(`isMoved is TRUE. Processing MOVED layout.`);
                let sidebarListRect = sidebarList.getBoundingClientRect();
                const userIDSectionRect = userIDSection.getBoundingClientRect();
                const totalColumnHeight = userIDSectionRect.top - sidebarListRect.top;
                const availableHeightForPanels = totalColumnHeight;

                if (availableHeightForPanels <= 0) {
                    this._warn(
                        `applyCurrentLayoutState: Available height for panels is zero or negative. Skipping moved layout update.`
                    );
                    return;
                }
                const calculatedSidebarHeight = availableHeightForPanels * this.sidebarHeightPercentage;
                const calculatedMembersTotalHeight = availableHeightForPanels * this.membersHeightPercentage;

                // Set sidebarList height. This is always done, as it's a prerequisite for layout calculation.
                sidebarList.style.height = `${calculatedSidebarHeight}px`;
                sidebarListRect = sidebarList.getBoundingClientRect();

                // applyMovedLayoutStyles will handle membersListContainer gracefully if it's null
                this._log(`applyCurrentLayoutState: Calling applyMovedLayoutStyles.`);
                this.applyMovedLayoutStyles(
                    membersWrap,
                    sidebarList,
                    membersListContainer,
                    calculatedSidebarHeight,
                    calculatedMembersTotalHeight,
                    sidebarListRect
                );

                // --- Manage our custom UI element's parenting and visibility for MOVED state ---
                // Our elements must always be visible in the moved state.
                // Resize handle should be a direct child of membersWrap and visible
                if (this.resizeHandle) {
                    if (!membersWrap.contains(this.resizeHandle)) {
                        membersWrap.prepend(this.resizeHandle);
                        this._log(`Re-parented resize handle to membersWrap (MOVED state).`);
                    }
                    this.resizeHandle.style.display = "flex";
                    this._log(`Resize handle display set to flex (MOVED state).`);
                }

                // Button wrapper should be a direct child of membersWrap and visible
                if (this.wrapperDiv) {
                    if (!membersWrap.contains(this.wrapperDiv)) {
                        // Ensure it's inserted after the resizeHandle if both exist
                        if (this.resizeHandle && membersWrap.contains(this.resizeHandle)) {
                            membersWrap.insertBefore(this.wrapperDiv, this.resizeHandle.nextSibling);
                        } else {
                            membersWrap.appendChild(this.wrapperDiv); // Fallback if resizeHandle is missing
                        }
                        this._log(`Re-parented button wrapper to membersWrap (MOVED state).`);
                    }
                    this.wrapperDiv.style.display = "flex"; // Always visible in flex container
                    this._log(`Button wrapper display set to flex (MOVED state).`);
                }

                // Window resize listener is always added when in the moved layout
                if (!window.bdResizeListenerAdded) {
                    window.addEventListener("resize", this.onResizeHandler);
                    window.bdResizeListenerAdded = true;
                    this._log(`Added window resize listener.`);
                } else {
                    this._log(`Window resize listener already added.`);
                }
                this._log(`MOVED layout processing completed (applied: true).`);
            } else {
                // If isMoved is FALSE (Original Layout)
                this._log(`isMoved is FALSE. Processing ORIGINAL layout.`);

                this.applyOriginalLayoutStyles(); // This resets Discord elements

                // --- Manage our custom UI element's parenting and visibility for ORIGINAL state ---
                // Resize handle should be removed from DOM and hidden
                if (this.resizeHandle) {
                    if (this.resizeHandle.parentNode) {
                        this.resizeHandle.parentNode.removeChild(this.resizeHandle);
                        this._log(`Removed resize handle from DOM (ORIGINAL state).`);
                    }
                    this.resizeHandle.style.display = "none"; // Ensure it's hidden
                }

                // Button wrapper should be a child of membersListContainer and visible
                if (this.wrapperDiv && membersListContainer) {
                    if (!membersListContainer.contains(this.wrapperDiv)) {
                        membersListContainer.prepend(this.wrapperDiv); // Prepend to Discord's content container
                        this._log(`Re-parented button wrapper to membersListContainer (ORIGINAL state).`);
                    }
                    this.wrapperDiv.style.display = "flex"; // Always visible in original state
                    this._log(`Button wrapper display set to flex (ORIGINAL state).`);
                } else if (this.wrapperDiv && this.wrapperDiv.parentNode) {
                    // If no membersListContainer, but it's still parented to something else, remove it
                    this.wrapperDiv.parentNode.removeChild(this.wrapperDiv);
                    this.wrapperDiv.style.display = "none"; // Ensure it's hidden
                    this._warn(`Button wrapper removed from DOM as no suitable parent found.`);
                } else if (this.wrapperDiv && !membersListContainer) {
                    this._warn(
                        `Button wrapper exists, but membersListContainer not found to re-parent to (ORIGINAL state).`
                    );
                }

                // Window resize listener is only removed when applying the original layout
                if (window.bdResizeListenerAdded) {
                    window.removeEventListener("resize", this.onResizeHandler);
                    window.bdResizeListenerAdded = false;
                    this._log(`Removed window resize listener.`);
                } else {
                    this._log(`Window resize listener was not added, no need to remove.`);
                }
                this._log(`ORIGINAL layout processing completed (applied: true).`);
            }
            // Update button visuals regardless of reporting mode
            this.updateButtonVisualState(this.button, this.wrapperDiv, this.subContainerDiv, this.isMoved);
            this._log(`applyCurrentLayoutState logic block completed successfully.`);
        } catch (e) {
            this._error(`CRITICAL ERROR in applyCurrentLayoutState:`, e.message, e.stack);
            // Re-throw to ensure the crash is still observable by Discord's error handling,
            // but now with our valuable diagnostic information.
            throw e;
        }
    }

    /**
     * Adds the "Move" button to the DOM and defines its click logic.
     * This method is idempotent, meaning it won't add duplicates if called multiple times.
     * It now ONLY creates elements in memory. Their DOM placement is handled by applyCurrentLayoutState.
     */
    addMoveButton() {
        const membersWrap = document.querySelector('[class*="membersWrap"]');
        if (!membersWrap) {
            this._warn(`membersWrap element not found during addMoveButton. Cannot create button elements.`);
            return;
        }

        // Ensure Discord's membersListContainer has an ID for consistent targeting
        let membersListContainer = membersWrap.querySelector('[class*="members"]');
        if (membersListContainer) {
            membersListContainer.id = "bd-members-list-container";
            this._log(`Ensured ID "bd-members-list-container" on Discord\'s members content container.`);
        } else {
            this._log(
                `Discord's members content container (by class) not found inside membersWrap during addMoveButton. Will attempt to locate it later.`
            );
        }

        // Create/ensure resize handle exists in memory
        if (!this.resizeHandle) {
            this._log(`Creating new resize handle in memory.`);
            const resizeHandle = document.createElement("div");
            resizeHandle.id = "bd-resize-handle";
            // Note: No z-index or initial display set here. Display is handled by applyCurrentLayoutState.
            resizeHandle.style.cssText = `
                width: 100%;
                height: 8px; 
                margin: 2px 0px 6px; 
                cursor: ns-resize;
                align-items: center;
                justify-content: center;
                border-radius: 5px; 
            `;
            this.resizeHandle = resizeHandle;

            const handleIndicator = document.createElement("div");
            handleIndicator.style.cssText = `
                width: 100%; 
                height: 4px; 
                margin: 0 5px; 
                background-color: var(--bg-brand); 
                border-radius: 2px; 
                opacity: 0.25; 
                transition: opacity 0.2s ease; 
            `;
            this.handleIndicator = handleIndicator;
            resizeHandle.appendChild(handleIndicator);
        } else {
            this._log(`Re-using existing resize handle from memory.`);
            this.handleIndicator = this.resizeHandle.querySelector("div");
        }

        // Attach resize handle events (always re-attach to ensure they are active)
        this.resizeHandle.onmouseover = () => {
            if (this.handleIndicator) this.handleIndicator.style.opacity = "0.5";
        };
        this.resizeHandle.onmouseout = () => {
            if (this.handleIndicator) this.handleIndicator.style.opacity = "0.25";
        };
        this.resizeHandle.onmousedown = (e) => {
            if (!this.isMoved) return;
            this.isDragging = true;
            this.initialMouseY = e.clientY;
            this.initialSidebarHeightPercentage = this.sidebarHeightPercentage;
            this.initialMembersHeightPercentage = this.membersHeightPercentage;
            window.addEventListener("mousemove", this.onMouseMoveHandler);
            window.addEventListener("mouseup", this.onMouseUpHandler);
            e.preventDefault();
            this._log(`Started dragging resize handle.`);
        };

        // Create/ensure button wrapper exists in memory
        if (!this.wrapperDiv) {
            this._log(`Creating new button wrapper and button in memory.`);
            this.wrapperDiv = document.createElement("div");
            this.wrapperDiv.id = "bd-move-button-wrapper";
            // Note: Initial display set here, z-index set to 1.
            this.wrapperDiv.style.cssText = `
                position: relative;
                height: 6px; 
                margin: 2px 10px;
                background-color: #5865F2;
                border-radius: 3px; 
                transition: background-color 0.2s ease;
                overflow: visible;
                display: flex; /* Always display as flex to contain button */
                align-items: center;
                justify-content: center;
                z-index: 1; /* Set z-index for button wrapper as requested */
                cursor: pointer;
                min-width: 10px; 
            `;

            let subContainerDiv = document.createElement("div");
            subContainerDiv.id = "bd-move-button-sub-wrapper";
            subContainerDiv.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                max-height: 0;
                overflow: hidden;
                transition: max-height 0.25s ease;
            `;
            this.subContainerDiv = subContainerDiv;

            const moveButton = document.createElement("button");
            moveButton.id = "bd-move-members-button";
            moveButton.textContent = "Move";
            this.button = moveButton;

            moveButton.style.cssText = `
                position: relative;
                top: 0px;
                width: 100%;
                background-color: #5865F2;
                color: white;
                border: none;
                padding: 8px 12px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 14px;
                text-align: center;
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            `;

            subContainerDiv.appendChild(this.button);
            this.wrapperDiv.appendChild(subContainerDiv);
        } else {
            this._log(`Re-using existing button wrapper from memory.`);
            this.subContainerDiv = this.wrapperDiv.querySelector("#bd-move-button-sub-wrapper");
            this.button = this.subContainerDiv ? this.subContainerDiv.querySelector("#bd-move-members-button") : null;
        }

        // Attach button wrapper and button events (always re-attach)
        if (this.wrapperDiv && this.subContainerDiv && this.button) {
            this.wrapperDiv.onmouseover = () => {
                this.wrapperDiv.style.backgroundColor = "transparent";
                this.subContainerDiv.style.maxHeight = "3em";
                this._log(`Hover ON: max-height set to 3em.`);
            };
            this.wrapperDiv.onmouseout = () => {
                this.wrapperDiv.style.backgroundColor = this.isMoved ? "#ED4245" : "#5865F2";
                this.subContainerDiv.style.maxHeight = "0";
                this._log(`Hover OFF: max-height set to 0.`);
            };
            this.button.onclick = (event) => {
                event.stopPropagation();
                this.isMoved = !this.isMoved;
                BdApi.saveData(this.pluginId, this.dataKey, this.isMoved);
                BdApi.saveData(this.pluginId, this.heightsDataKey, {
                    sidebar: this.sidebarHeightPercentage,
                    members: this.membersHeightPercentage
                });
                this.queueLayoutReapply(); // Trigger re-application
            };
        }

        // This function now only creates/re-attaches event listeners.
        // Actual DOM appending/re-parenting is handled by applyCurrentLayoutState.
        this._log(`addMoveButton finished. Custom elements are in memory with event listeners.`);
    }

    /** Helper to update the button's visual state (text, color) and wrappers' initial state **/
    updateButtonVisualState(buttonElement, wrapperElement, subContainerElement, isMovedState) {
        if (!buttonElement || !wrapperElement || !subContainerElement || !this.resizeHandle || !this.handleIndicator) {
            this._warn(`updateButtonVisualState called with missing elements.`);
            return;
        }

        if (isMovedState) {
            buttonElement.textContent = "Reset Layout";
            buttonElement.style.backgroundColor = "#ED4245";
            buttonElement.onmouseover = function () {
                this.style.backgroundColor = "#C7383B";
            };
            buttonElement.onmouseout = function () {
                this.style.backgroundColor = "#ED4245";
            };
            wrapperElement.style.backgroundColor = "#ED4245";
        } else {
            buttonElement.textContent = "Move";
            buttonElement.style.backgroundColor = "#5865F2";
            buttonElement.onmouseover = function () {
                this.style.backgroundColor = "#4752C4";
            };
            buttonElement.onmouseout = function () {
                this.style.backgroundColor = "#5865F2";
            };
            wrapperElement.style.backgroundColor = "#5865F2";
        }

        // Removed display logic from here, it's handled in applyCurrentLayoutState
        this._log(`Button visual state updated.`);
    }

    // New: Mouse move handler for resizing
    onMouseMove(e) {
        if (!this.isDragging) return;

        const sidebarList = document.querySelector('[class*="sidebarList"]');
        const userIDSection = document.querySelector('[class*="sidebarList"] ~ section');

        if (!sidebarList || !userIDSection) {
            this._warn(`Missing elements for resize during mousemove.`);
            return;
        }

        const sidebarListRect = sidebarList.getBoundingClientRect();
        const userIDSectionRect = userIDSection.getBoundingClientRect();

        const totalAvailableHeightForPanels = userIDSectionRect.top - sidebarListRect.top;

        if (totalAvailableHeightForPanels <= 0) {
            this._warn(`Total available height for panels is zero or negative during drag. Skipping resize.`);
            return;
        }

        let newSidebarHeightPx = e.clientY - sidebarListRect.top;

        let newSidebarPercentage = newSidebarHeightPx / totalAvailableHeightForPanels;
        let newMembersPercentage = 1.0 - newSidebarPercentage;

        newSidebarPercentage = Math.max(
            this.MIN_HEIGHT_PERCENTAGE,
            Math.min(1 - this.MIN_HEIGHT_PERCENTAGE, newSidebarPercentage)
        );
        newMembersPercentage = Math.max(
            this.MIN_HEIGHT_PERCENTAGE,
            Math.min(1 - this.MIN_HEIGHT_PERCENTAGE, newMembersPercentage)
        );

        const sum = newSidebarPercentage + newMembersPercentage;
        if (Math.abs(sum - 1.0) > 0.001) {
            const error = sum - 1.0;
            newSidebarPercentage -= error / 2;
            newMembersPercentage -= error / 2;
        }

        this.sidebarHeightPercentage = parseFloat(newSidebarPercentage.toFixed(3));
        this.membersHeightPercentage = parseFloat(newMembersPercentage.toFixed(3));

        this.queueLayoutReapply(); // Use queueLayoutReapply for all external triggers

        BdApi.saveData(this.pluginId, this.dataKey, {
            sidebar: this.sidebarHeightPercentage,
            members: this.membersHeightPercentage
        });
        this._log(
            `Heights saved during drag: Sidebar = ${this.sidebarHeightPercentage.toFixed(3)}%, Members = ${this.membersHeightPercentage.toFixed(3)}%.`
        );
    }

    // New: Mouse up handler to stop dragging
    onMouseUp() {
        this.isDragging = false;
        window.removeEventListener("mousemove", this.onMouseMoveHandler);
        window.removeEventListener("mouseup", this.onMouseUpHandler);
        this._log(`Stopped dragging resize handle. Final heights saved.`);
    }

    /**
     * Sets up the MutationObserver to watch for relevant DOM changes.
     */
    setupObserver() {
        if (this.observer) {
            this.observer.disconnect();
            this._log(`Previous MutationObserver disconnected before setup.`);
        }

        this.observer = new MutationObserver((mutationsList) => {
            let layoutReapplyNeeded = false; // Flag to indicate if a layout re-application is necessary

            for (const mutation of mutationsList) {
                const targetElement = mutation.target;

                // Check for attribute changes on relevant elements (like inline styles)
                if (mutation.type === "attributes" && mutation.attributeName === "style") {
                    if (targetElement.matches('[class*="membersWrap"]')) {
                        this._log(`Observer: DETECTED Style Change on membersWrap.`);
                        layoutReapplyNeeded = true;
                    } else if (targetElement.matches('[class*="sidebarList"]')) {
                        this._log(`Observer: DETECTED Style Change on sidebarList.`);
                        layoutReapplyNeeded = true;
                    } else if (
                        targetElement.id === "bd-members-list-container" ||
                        targetElement.id === "bd-move-button-wrapper" ||
                        targetElement.id === "bd-resize-handle"
                    ) {
                        this._log(`Observer: DETECTED Style Change on our custom element (${targetElement.id}).`);
                        layoutReapplyNeeded = true;
                    }
                }
                // Check for childList changes (appearance/disappearance of elements)
                else if (mutation.type === "childList") {
                    // Any childList mutation indicates a structural change that might require layout re-application
                    layoutReapplyNeeded = true;

                    // Check removed nodes specifically for membersWrap
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType === 1 && node.matches('[class*="membersWrap"]')) {
                            // Element node
                            this._log(`Observer: DETECTED membersWrap REMOVED from removedNodes list.`);
                            // Explicit removal detected, will trigger absence check later.
                        }
                    }
                    // Check added nodes for relevant elements
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            // Element node
                            if (node.matches('[class*="membersWrap"]')) {
                                this._log(`Observer: DETECTED membersWrap ADDED.`);
                                // If it was just added, it's not "absent" anymore. Clear any pending absence timer.
                                if (this.memberListAbsenceTimer) {
                                    clearTimeout(this.memberListAbsenceTimer);
                                    this.memberListAbsenceTimer = null;
                                    this._log(
                                        `MemberListAbsence: Cleared absence check timer because membersWrap ADDED.`
                                    );
                                }
                            }
                            // Also check if critical elements are inside an added subtree
                            if (
                                node.querySelector('[class*="membersWrap"]') ||
                                node.querySelector('[class*="sidebarList"]') ||
                                node.querySelector("#bd-members-list-container")
                            ) {
                                this._log(`Observer: DETECTED critical element within added subtree.`);
                            }
                        }
                    }
                }
            }

            // After processing all mutations in the batch:
            // 1. If any relevant layout change was detected, queue a throttled re-application.
            if (layoutReapplyNeeded) {
                this._log(`Observer: Layout re-application deemed needed. Queueing throttled re-application.`);
                this.queueLayoutReapply();
            } else {
                this._log(`Observer: No relevant layout mutation found in this batch.`);
            }

            // 2. Separately, check if membersWrap is currently absent from the DOM.
            // This catches cases where it's removed indirectly (e.g., parent removed).
            const currentMembersWrap = document.querySelector('[class*="membersWrap"]');
            if (!currentMembersWrap) {
                this._log(`Observer: membersWrap is currently NOT found in DOM. Triggering absence handler.`);
                this.handleMemberListAbsence();
            } else {
                // If membersWrap IS present, ensure any pending absence timer is cleared.
                // This covers cases where it briefly disappeared and then reappeared before the timer fired.
                if (this.memberListAbsenceTimer) {
                    clearTimeout(this.memberListAbsenceTimer);
                    this.memberListAbsenceTimer = null;
                    this._log(`MemberListAbsence: Cleared absence check timer because membersWrap is now PRESENT.`);
                }
            }
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style"]
        });
        this._log(`MutationObserver started observing document.body.`);
    }

    /**
     * Throttles calls to applyCurrentLayoutState.
     * Ensures applyCurrentLayoutState is called immediately on the first trigger,
     * then at most once within the 'reapplyThrottleDelay' period for subsequent triggers,
     * with one pending call allowed to execute after the cooldown if triggered during it.
     */
    queueLayoutReapply() {
        // Clear any previous animation frame requests for immediate execution
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }

        if (this.isThrottling) {
            // If currently in a throttle cooldown period, just mark that a call is pending
            // This ensures only one future call is queued for the end of the current cooldown
            this.pendingThrottleCall = true;
            this._log(`Throttling: Call received during cooldown, pending call marked.`);
            return; // Exit, do not schedule another immediate or timeout
        }

        // If not throttling, execute immediately and start cooldown
        this._log(`Throttling: Executing immediately.`);
        this.isThrottling = true; // Enter throttling mode
        this.pendingThrottleCall = false; // Reset pending call flag for this new throttle window

        // Schedule the function execution on the next animation frame for smoother visual updates
        this.animationFrameId = requestAnimationFrame(() => {
            this.lastLayoutApplyTimestamp = Date.now(); // Record time of actual execution
            this.applyCurrentLayoutState(); // No longer passes isReportingOnly
            this.animationFrameId = null; // Clear animation frame ID after execution
        });

        // Set a timeout to end the throttle cooldown period.
        // This setTimeout will also check if a pending call was accumulated during the cooldown.
        this.reapplyTimeout = setTimeout(() => {
            this.isThrottling = false; // Exit throttling mode
            this.reapplyTimeout = null; // Clear the timeout ID

            if (this.pendingThrottleCall) {
                // If a call was pending during the cooldown, immediately trigger another call.
                // This new call will start a new throttle cycle.
                this._log(`Throttling: Cooldown ended, processing pending call.`);
                this.pendingThrottleCall = false; // Reset for the next cycle before re-queueing
                this.queueLayoutReapply(); // Re-queue to execute the pending call (no isReportingOnly)
            } else {
                this._log(`Throttling: Cooldown ended, no pending calls.`);
            }
        }, this.reapplyThrottleDelay);
    }

    /**
     * Failsafe check function. Periodically checks layout and button integrity.
     * This always triggers an *actual* layout application.
     */
    checkAndReapplyLayout() {
        // Defensive check: if core Discord elements aren't present, return.
        const currentMembersWrap = document.querySelector('[class*="membersWrap"]');
        if (!currentMembersWrap) {
            this._warn(`Failsafe: membersWrap not found. Skipping failsafe checks.`);
            return;
        }

        const currentSidebarList = document.querySelector('[class*="sidebarList"]');
        if (!currentSidebarList) {
            this._warn(`Failsafe: sidebarList not found. Skipping failsafe checks.`);
            return;
        }

        const currentUserIDSection = document.querySelector('[class*="sidebarList"] ~ section');
        if (!currentUserIDSection) {
            this._warn(`Failsafe: userIDSection not found. Skipping failsafe checks.`);
            return;
        }

        const currentMembersListContainer = currentMembersWrap.querySelector('[class*="members"]');
        if (!currentMembersListContainer) {
            this._warn(`Failsafe: membersListContainer not found within membersWrap. Skipping failsafe checks.`);
            return;
        }
        currentMembersListContainer.id = "bd-members-list-container";

        // Ensure our custom UI elements exist in memory and are handled by applyCurrentLayoutState
        if (!this.button || !this.wrapperDiv || !this.resizeHandle) {
            this.addMoveButton();
            this._warn(
                `Failsafe: Re-created custom UI elements (or they were missing in memory) during failsafe check.`
            );
        }

        // We only check for presence in DOM and correct display state here,
        // as parentage is managed by applyCurrentLayoutState
        const actualWrapperDiv = document.querySelector("#bd-move-button-wrapper");
        const actualResizeHandle = document.querySelector("#bd-resize-handle");

        let needsReapply = false;
        let warnings = [];

        const PIXEL_TOLERANCE = 0.1;

        const compareFloats = (val1, val2, tolerance) => {
            return Math.abs(val1 - val2) < tolerance;
        };

        // --- Presence and Visibility Checks for plugin UI elements ---
        if (this.isMoved) {
            if (!actualWrapperDiv || actualWrapperDiv.parentNode !== currentMembersWrap) {
                warnings.push("Failsafe: MOVED state - Button wrapper missing or not a child of membersWrap.");
                needsReapply = true;
            }
            if (!actualResizeHandle || actualResizeHandle.parentNode !== currentMembersWrap) {
                warnings.push("Failsafe: MOVED state - Resize handle missing or not a child of membersWrap.");
                needsReapply = true;
            }
            if (
                actualWrapperDiv &&
                (!actualWrapperDiv.querySelector("#bd-move-button-sub-wrapper") ||
                    !actualWrapperDiv.querySelector("#bd-move-members-button"))
            ) {
                warnings.push("Failsafe: MOVED state - Button wrapper's children missing.");
                needsReapply = true;
            }
            if (actualResizeHandle && !actualResizeHandle.querySelector("div")) {
                warnings.push("Failsafe: MOVED state - Resize handle's indicator missing.");
                needsReapply = true;
            }

            if (actualResizeHandle && actualResizeHandle.style.display !== "flex") {
                warnings.push(
                    `Failsafe: MOVED state - Resize handle expected display 'flex', got '${actualResizeHandle.style.display}'.`
                );
                needsReapply = true;
            }
            if (actualWrapperDiv && actualWrapperDiv.style.display !== "flex") {
                warnings.push(
                    `Failsafe: MOVED state - Button wrapper expected display 'flex', got '${actualWrapperDiv.style.display}'.`
                );
                needsReapply = true;
            }
        } else {
            // Not moved state (Original Layout)
            if (!actualWrapperDiv || actualWrapperDiv.parentNode !== currentMembersListContainer) {
                warnings.push(
                    "Failsafe: ORIGINAL state - Button wrapper missing or not a child of membersListContainer."
                );
                needsReapply = true;
            }
            // Resize handle should NOT be present in the DOM for original state
            if (actualResizeHandle && actualResizeHandle.parentNode) {
                warnings.push("Failsafe: ORIGINAL state - Resize handle unexpectedly found in DOM.");
                needsReapply = true;
            }
            if (
                actualWrapperDiv &&
                (!actualWrapperDiv.querySelector("#bd-move-button-sub-wrapper") ||
                    !actualWrapperDiv.querySelector("#bd-move-members-button"))
            ) {
                warnings.push("Failsafe: ORIGINAL state - Button wrapper's children missing.");
                needsReapply = true;
            }

            if (actualWrapperDiv && actualWrapperDiv.style.display !== "flex") {
                warnings.push(
                    `Failsafe: ORIGINAL state - Button wrapper expected display 'flex', got '${actualWrapperDiv.style.display}'.`
                );
                needsReapply = true;
            }
        }

        // Exit early if fundamental presence/parentage/visibility issues for our elements are found, as style checks will likely fail.
        if (needsReapply) {
            this._warn(
                `Failsafe triggered early due to missing/mis-parented/wrong-display critical plugin elements. Re-application queued.`
            );
            warnings.forEach((warning) => this._warn(`  - ${warning}`)); // Use _warn for these too
            this.queueLayoutReapply(); // Call without isReportingOnly, so it applies fix
            return;
        }

        // --- Style Integrity Checks (only proceed if elements are present and correctly parented/displayed) ---

        // Retrieve rects again *after* confirming elements are present.
        const tempSidebarListRect = currentSidebarList.getBoundingClientRect();
        const tempUserIDSectionRect = currentUserIDSection.getBoundingClientRect();

        const totalColumnHeight = tempUserIDSectionRect.top - tempSidebarListRect.top;
        const availableHeightForPanels = totalColumnHeight;

        if (availableHeightForPanels <= 0) {
            warnings.push("Failsafe: Available height for panels is zero or negative. Recalculating.");
            needsReapply = true;
        }

        const expectedSidebarHeight = availableHeightForPanels * this.sidebarHeightPercentage;
        const expectedMembersHeight = availableHeightForPanels * this.membersHeightPercentage;
        const expectedMembersWrapTop = tempSidebarListRect.bottom;
        const expectedMembersWrapWidth = tempSidebarListRect.width;

        if (this.isMoved) {
            // Check membersWrap styles
            if (currentMembersWrap && currentMembersWrap.style.position !== "fixed") {
                warnings.push(
                    `Failsafe: membersWrap position expected 'fixed', got '${currentMembersWrap.style.position}'.`
                );
                needsReapply = true;
            }
            if (
                currentMembersWrap &&
                !compareFloats(parseFloat(currentMembersWrap.style.width), expectedMembersWrapWidth, PIXEL_TOLERANCE)
            ) {
                warnings.push(
                    `Failsafe: membersWrap width expected '${expectedMembersWrapWidth.toFixed(3)}px', got '${parseFloat(currentMembersWrap.style.width).toFixed(3)}px'.`
                );
                needsReapply = true;
            }
            if (
                currentMembersWrap &&
                !compareFloats(parseFloat(currentMembersWrap.style.height), expectedMembersHeight, PIXEL_TOLERANCE)
            ) {
                warnings.push(
                    `Failsafe: membersWrap height expected '${expectedMembersHeight.toFixed(3)}px', got '${parseFloat(currentMembersWrap.style.height).toFixed(3)}px'.`
                );
                needsReapply = true;
            }
            if (
                currentMembersWrap &&
                !compareFloats(parseFloat(currentMembersWrap.style.left), tempSidebarListRect.left, PIXEL_TOLERANCE)
            ) {
                warnings.push(
                    `Failsafe: membersWrap left expected '${tempSidebarListRect.left.toFixed(3)}px', got '${parseFloat(currentMembersWrap.style.left).toFixed(3)}px'.`
                );
                needsReapply = true;
            }
            if (
                currentMembersWrap &&
                !compareFloats(parseFloat(currentMembersWrap.style.top), expectedMembersWrapTop, PIXEL_TOLERANCE)
            ) {
                warnings.push(
                    `Failsafe: membersWrap top expected '${expectedMembersWrapTop.toFixed(3)}px', got '${parseFloat(currentMembersWrap.style.top).toFixed(3)}px'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.transform !== "translateX(0%)") {
                warnings.push(
                    `Failsafe: membersWrap transform expected 'translateX(0%)', got '${currentMembersWrap.style.transform}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.flexDirection !== "column") {
                warnings.push(
                    `Failsafe: membersWrap flexDirection expected 'column', got '${currentMembersWrap.style.flexDirection}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.display !== "flex") {
                warnings.push(
                    `Failsafe: membersWrap display expected 'flex', got '${currentMembersWrap.style.display}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.zIndex) {
                warnings.push(`Failsafe: membersWrap z-index found: '${currentMembersWrap.style.zIndex}'.`);
                needsReapply = true;
            } // Check for z-index

            if (
                currentSidebarList &&
                !compareFloats(parseFloat(currentSidebarList.style.height), expectedSidebarHeight, PIXEL_TOLERANCE)
            ) {
                warnings.push(
                    `Failsafe: sidebarList height expected '${expectedSidebarHeight.toFixed(3)}px', got '${parseFloat(currentSidebarList.style.height).toFixed(3)}px'.`
                );
                needsReapply = true;
            }
            if (currentSidebarList && currentSidebarList.style.paddingBottom !== "0px") {
                warnings.push(
                    `Failsafe: sidebarList paddingBottom expected '0px', got '${currentSidebarList.style.paddingBottom}'.`
                );
                needsReapply = true;
            }

            const expectedRemainingHeightForContent = expectedMembersHeight - this.OUR_UI_HEIGHT_PX;
            if (currentMembersListContainer) {
                // Only check if present
                if (
                    !compareFloats(
                        parseFloat(currentMembersListContainer.style.height),
                        Math.max(0, expectedRemainingHeightForContent),
                        PIXEL_TOLERANCE
                    )
                ) {
                    warnings.push(
                        `Failsafe: membersListContainer height expected '${Math.max(0, expectedRemainingHeightForContent).toFixed(3)}px', got '${parseFloat(currentMembersListContainer.style.height).toFixed(3)}px'.`
                    );
                    needsReapply = true;
                }
                if (currentMembersListContainer.style.width !== "100%") {
                    warnings.push(
                        `Failsafe: membersListContainer width expected '100%', got '${currentMembersListContainer.style.width}'.`
                    );
                    needsReapply = true;
                }
                if (currentMembersListContainer.style.overflowY !== "auto") {
                    warnings.push(
                        `Failsafe: membersListContainer overflowY expected 'auto', got '${currentMembersListContainer.style.overflowY}'.`
                    );
                    needsReapply = true;
                }
            } else {
                // If moved, membersListContainer being absent is a deviation we need to fix
                warnings.push(
                    "Failsafe: MOVED state - membersListContainer is NOT present when it should be for full layout."
                );
                needsReapply = true;
            }
        } else {
            // Checks for ORIGINAL state
            if (currentMembersWrap && currentMembersWrap.style.position) {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersWrap position found: '${currentMembersWrap.style.position}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.width !== "") {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersWrap width found: '${currentMembersWrap.style.width}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.height !== "") {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersWrap height found: '${currentMembersWrap.style.height}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.flexDirection !== "") {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersWrap flexDirection found: '${currentMembersWrap.style.flexDirection}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.display !== "") {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersWrap display found: '${currentMembersWrap.style.display}'.`
                );
                needsReapply = true;
            }
            if (currentMembersWrap && currentMembersWrap.style.zIndex) {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersWrap z-index found: '${currentMembersWrap.style.zIndex}'.`
                );
                needsReapply = true;
            } // Check for z-index

            if (currentMembersListContainer && currentMembersListContainer.style.height !== "") {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersListContainer height found: '${currentMembersListContainer.style.height}'.`
                );
                needsReapply = true;
            }
            if (currentMembersListContainer && currentMembersListContainer.style.overflowY !== "") {
                warnings.push(
                    `Failsafe: ORIGINAL state - membersListContainer overflowY found: '${currentMembersListContainer.style.overflowY}'.`
                );
                needsReapply = true;
            }

            if (currentSidebarList && currentSidebarList.style.height !== "") {
                warnings.push(
                    `Failsafe: ORIGINAL state - sidebarList height found: '${currentSidebarList.style.height}'.`
                );
                needsReapply = true;
            }
        }

        if (needsReapply) {
            this._warn(`Failsafe triggered a re-application due to deviations:`);
            warnings.forEach((warning) => this._warn(`  - ${warning}`));
            this.queueLayoutReapply(); // Call without isReportingOnly, so it applies fix
        }
    }

    /**
     * Resets height and padding-bottom styles on the sidebarList element.
     * This is used when the member list is confirmed absent and our plugin
     * needs to release control of the sidebar's sizing.
     * @private
     */
    _resetSidebarListStyles() {
        const sidebarList = document.querySelector('[class*="sidebarList"]');
        if (sidebarList) {
            sidebarList.style.removeProperty("height");
            sidebarList.style.removeProperty("padding-bottom");
            const sidebarNav = sidebarList.querySelector("nav");
            if (sidebarNav) {
                sidebarNav.style.removeProperty("padding-bottom");
            }
            this._log(`_resetSidebarListStyles: SidebarList styles removed.`);
        }
    }

    /**
     * Handles the scenario where the membersWrap element is detected as absent.
     * It sets a delayed check to confirm persistent absence before resetting sidebar styles.
     */
    handleMemberListAbsence() {
        // Clear any existing timer to prevent multiple checks
        if (this.memberListAbsenceTimer) {
            clearTimeout(this.memberListAbsenceTimer);
            this.memberListAbsenceTimer = null;
            this._log(`MemberListAbsence: Cleared previous absence check timer.`);
        }

        this._log(
            `MemberListAbsence: Scheduling delayed check for membersWrap absence in ${this.ABSENCE_CHECK_DELAY_MS}ms.`
        );

        this.memberListAbsenceTimer = setTimeout(() => {
            const membersWrap = document.querySelector('[class*="membersWrap"]');
            if (!membersWrap) {
                this._log(
                    `MemberListAbsence: membersWrap still NOT found after ${this.ABSENCE_CHECK_DELAY_MS}ms. Proceeding to reset sidebar styles.`
                );
                this._resetSidebarListStyles();
            } else {
                this._log(
                    `MemberListAbsence: membersWrap FOUND after ${this.ABSENCE_CHECK_DELAY_MS}ms. Not resetting sidebar styles. Re-applying layout.`
                );
                this.queueLayoutReapply();
            }
            this.memberListAbsenceTimer = null; // Clear timer ID after execution
        }, this.ABSENCE_CHECK_DELAY_MS);
    }
};
