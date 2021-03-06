﻿/// <reference path="../../definitions/generated/code-push.d.ts" />

import AccountManager = require("code-push");
import * as base64 from "base-64";
import * as chalk from "chalk";
var childProcess = require("child_process");
import * as fs from "fs";
var g2js = require("gradle-to-js/lib/parser");
import * as moment from "moment";
var opener = require("opener");
import * as os from "os";
import * as path from "path";
var plist = require("plist");
var progress = require("progress");
var prompt = require("prompt");
import * as Q from "q";
import * as recursiveFs from "recursive-fs";
var rimraf = require("rimraf");
import * as semver from "semver";
import slash = require("slash");
var Table = require("cli-table");
import * as yazl from "yazl";
import wordwrap = require("wordwrap");

import * as cli from "../definitions/cli";
import { AccessKey, Account, App, CollaboratorMap, CollaboratorProperties, Deployment, DeploymentMetrics, Headers, Package, UpdateMetrics } from "code-push/script/types";

var configFilePath: string = path.join(process.env.LOCALAPPDATA || process.env.HOME, ".code-push.config");
var emailValidator = require("email-validator");
var packageJson = require("../package.json");
var parseXml = Q.denodeify(require("xml2js").parseString);
var progress = require("progress");
import Promise = Q.Promise;

const ACTIVE_METRICS_KEY: string = "Active";
const CLI_HEADERS: Headers = {
    "X-CodePush-CLI-Version": packageJson.version
};
const DOWNLOADED_METRICS_KEY: string = "Downloaded";

interface NameToCountMap {
    [name: string]: number;
}

/** Deprecated */
interface ILegacyLoginConnectionInfo {
    accessKeyName: string;
}

interface ILoginConnectionInfo {
    accessKey: string;
    customServerUrl?: string;   // A custom serverUrl for internal debugging purposes
    preserveAccessKeyOnLogout?: boolean;
}

interface IPackageFile {
    isTemporary: boolean;
    path: string;
}

export interface UpdateMetricsWithTotalActive extends UpdateMetrics {
    totalActive: number;
}

export interface PackageWithMetrics {
    metrics?: UpdateMetricsWithTotalActive;
}

export var log = (message: string | Chalk.ChalkChain): void => console.log(message);
export var sdk: AccountManager;
export var spawn = childProcess.spawn;
export var spawnSync = childProcess.spawnSync;

var connectionInfo: ILoginConnectionInfo;

export var confirm = (): Promise<boolean> => {
    return Promise<boolean>((resolve, reject, notify): void => {
        prompt.message = "";
        prompt.delimiter = "";

        prompt.start();

        prompt.get({
            properties: {
                response: {
                    description: chalk.cyan("Are you sure? (Y/n):")
                }
            }
        }, (err: any, result: any): void => {
            if (!result.response || result.response === "" || result.response === "Y") {
                resolve(true);
            } else {
                if (result.response !== "n") console.log("Invalid response: \"" + result.response + "\"");
                resolve(false);
            }
        });
    });
}

function accessKeyAdd(command: cli.IAccessKeyAddCommand): Promise<void> {
    return sdk.addAccessKey(command.description)
        .then((accessKey: AccessKey) => {
            log("Successfully created a new access key" + (command.description ? (" \"" + command.description + "\"") : "") + ": " + accessKey.name);
        });
}

function accessKeyList(command: cli.IAccessKeyListCommand): Promise<void> {
    throwForInvalidOutputFormat(command.format);

    return sdk.getAccessKeys()
        .then((accessKeys: AccessKey[]): void => {
            printAccessKeys(command.format, accessKeys);
        });
}

function accessKeyRemove(command: cli.IAccessKeyRemoveCommand): Promise<void> {
    if (command.accessKey === sdk.accessKey) {
        throw new Error("Cannot remove the access key for the current session. Please run 'code-push logout' if you would like to remove this access key.");
    } else {
        return confirm()
            .then((wasConfirmed: boolean): Promise<void> => {
                if (wasConfirmed) {
                    return sdk.removeAccessKey(command.accessKey)
                        .then((): void => {
                            log("Successfully removed the \"" + command.accessKey + "\" access key.");
                        });
                }

                log("Access key removal cancelled.");
            });
    }
}

function appAdd(command: cli.IAppAddCommand): Promise<void> {
    return sdk.addApp(command.appName)
        .then((app: App): Promise<void> => {
            log("Successfully added the \"" + command.appName + "\" app, along with the following default deployments:");
            var deploymentListCommand: cli.IDeploymentListCommand = {
                type: cli.CommandType.deploymentList,
                appName: app.name,
                format: "table",
                displayKeys: true
            };
            return deploymentList(deploymentListCommand, /*showPackage=*/ false);
        });
}

function appList(command: cli.IAppListCommand): Promise<void> {
    throwForInvalidOutputFormat(command.format);
    var apps: App[];
    return sdk.getApps()
        .then((retrievedApps: App[]): Promise<string[][]> => {
            apps = retrievedApps;
            var deploymentListPromises: Promise<string[]>[] = apps.map((app: App) => {

                return sdk.getDeployments(app.name)
                    .then((deployments: Deployment[]) => {
                        var deploymentList: string[] = deployments
                            .map((deployment: Deployment) => deployment.name)
                            .sort((first: string, second: string) => {
                                return first.toLowerCase().localeCompare(second.toLowerCase());
                            });
                        return deploymentList;
                    });
            });
            return Q.all(deploymentListPromises);
        })
        .then((deploymentLists: string[][]): void => {
            printAppList(command.format, apps, deploymentLists);
        });
}

function appRemove(command: cli.IAppRemoveCommand): Promise<void> {
    return confirm()
        .then((wasConfirmed: boolean): Promise<void> => {
            if (wasConfirmed) {
                return sdk.removeApp(command.appName)
                    .then((): void => {
                        log("Successfully removed the \"" + command.appName + "\" app.");
                    });
            }

            log("App removal cancelled.");
        });
}

function appRename(command: cli.IAppRenameCommand): Promise<void> {
    return sdk.renameApp(command.currentAppName, command.newAppName)
        .then((): void => {
            log("Successfully renamed the \"" + command.currentAppName + "\" app to \"" + command.newAppName + "\".");
        });
}

export var createEmptyTempReleaseFolder = (folderPath: string) => {
    return deleteFolder(folderPath)
        .then(() => {
            fs.mkdirSync(folderPath);
        });
};

function appTransfer(command: cli.IAppTransferCommand): Promise<void> {
    throwForInvalidEmail(command.email);

    return confirm()
        .then((wasConfirmed: boolean): Promise<void> => {
            if (wasConfirmed) {
                return sdk.transferApp(command.appName, command.email)
                    .then((): void => {
                        log("Successfully transferred the ownership of app \"" + command.appName + "\" to the account with email \"" + command.email + "\".");
                    });
            }

            log("App transfer cancelled.");
        });
}

function addCollaborator(command: cli.ICollaboratorAddCommand): Promise<void> {
    throwForInvalidEmail(command.email);

    return sdk.addCollaborator(command.appName, command.email)
        .then((): void => {
            log("Successfully added \"" + command.email + "\" as a collaborator to the app \"" + command.appName + "\".");
        });
}

function listCollaborators(command: cli.ICollaboratorListCommand): Promise<void> {
    throwForInvalidOutputFormat(command.format);

    return sdk.getCollaborators(command.appName)
        .then((retrievedCollaborators: CollaboratorMap): void => {
            printCollaboratorsList(command.format, retrievedCollaborators);
        });
}

function removeCollaborator(command: cli.ICollaboratorRemoveCommand): Promise<void> {
    throwForInvalidEmail(command.email);

    return confirm()
        .then((wasConfirmed: boolean): Promise<void> => {
            if (wasConfirmed) {
                return sdk.removeCollaborator(command.appName, command.email)
                    .then((): void => {
                        log("Successfully removed \"" + command.email + "\" as a collaborator from the app \"" + command.appName + "\".");
                    });
            }

            log("App collaborator removal cancelled.");
        });
}

function deleteConnectionInfoCache(): void {
    try {
        fs.unlinkSync(configFilePath);

        log(`Successfully logged-out. The session file located at ${chalk.cyan(configFilePath)} has been deleted.\r\n`);
    } catch (ex) {
    }
}

function deleteFolder(folderPath: string): Promise<void> {
    return Promise<void>((resolve, reject, notify) => {
        rimraf(folderPath, (err: any) => {
            if (err) {
                reject(err);
            } else {
                resolve(<void>null);
            }
        });
    });
}

function deploymentAdd(command: cli.IDeploymentAddCommand): Promise<void> {
    return sdk.addDeployment(command.appName, command.deploymentName)
        .then((deployment: Deployment): void => {
            log("Successfully added the \"" + command.deploymentName + "\" deployment with key \"" + deployment.key + "\" to the \"" + command.appName + "\" app.");
        });
}

function deploymentHistoryClear(command: cli.IDeploymentHistoryClearCommand): Promise<void> {
    return confirm()
        .then((wasConfirmed: boolean): Promise<void> => {
            if (wasConfirmed) {
                return sdk.clearDeploymentHistory(command.appName, command.deploymentName)
                    .then((): void => {
                        log("Successfully cleared the release history associated with the \"" + command.deploymentName + "\" deployment from the \"" + command.appName + "\" app.");
                    })
            }

            log("Clear deployment cancelled.");
        });
}

export var deploymentList = (command: cli.IDeploymentListCommand, showPackage: boolean = true): Promise<void> => {
    throwForInvalidOutputFormat(command.format);
    var deployments: Deployment[];

    return sdk.getDeployments(command.appName)
        .then((retrievedDeployments: Deployment[]) => {
            deployments = retrievedDeployments;
            if (showPackage) {
                var metricsPromises: Promise<void>[] = deployments.map((deployment: Deployment) => {
                    if (deployment.package) {
                        return sdk.getDeploymentMetrics(command.appName, deployment.name)
                            .then((metrics: DeploymentMetrics): void => {
                                if (metrics[deployment.package.label]) {
                                    var totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
                                    (<PackageWithMetrics>(deployment.package)).metrics = {
                                        active: metrics[deployment.package.label].active,
                                        downloaded: metrics[deployment.package.label].downloaded,
                                        failed: metrics[deployment.package.label].failed,
                                        installed: metrics[deployment.package.label].installed,
                                        totalActive: totalActive
                                    };
                                }
                            });
                    } else {
                        return Q(<void>null);
                    }
                });

                return Q.all(metricsPromises);
            }
        })
        .then(() => {
            printDeploymentList(command, deployments, showPackage);
        });
}

function deploymentRemove(command: cli.IDeploymentRemoveCommand): Promise<void> {
    return confirm()
        .then((wasConfirmed: boolean): Promise<void> => {
            if (wasConfirmed) {
                return sdk.removeDeployment(command.appName, command.deploymentName)
                    .then((): void => {
                        log("Successfully removed the \"" + command.deploymentName + "\" deployment from the \"" + command.appName + "\" app.");
                    })
            }

            log("Deployment removal cancelled.");
        });
}

function deploymentRename(command: cli.IDeploymentRenameCommand): Promise<void> {
    return sdk.renameDeployment(command.appName, command.currentDeploymentName, command.newDeploymentName)
        .then((): void => {
            log("Successfully renamed the \"" + command.currentDeploymentName + "\" deployment to \"" + command.newDeploymentName + "\" for the \"" + command.appName + "\" app.");
        });
}

function deploymentHistory(command: cli.IDeploymentHistoryCommand): Promise<void> {
    throwForInvalidOutputFormat(command.format);

    return Q.all<any>([
        sdk.getAccountInfo(),
        sdk.getDeploymentHistory(command.appName, command.deploymentName),
        sdk.getDeploymentMetrics(command.appName, command.deploymentName)
    ])
        .spread<void>((account: Account, deploymentHistory: Package[], metrics: DeploymentMetrics): void => {
            var totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
            deploymentHistory.forEach((packageObject: Package) => {
                if (metrics[packageObject.label]) {
                    (<PackageWithMetrics>packageObject).metrics = {
                        active: metrics[packageObject.label].active,
                        downloaded: metrics[packageObject.label].downloaded,
                        failed: metrics[packageObject.label].failed,
                        installed: metrics[packageObject.label].installed,
                        totalActive: totalActive
                    };
                }
            });
            printDeploymentHistory(command, <PackageWithMetrics[]>deploymentHistory, account.email);
        });
}

function deserializeConnectionInfo(): ILoginConnectionInfo {
    try {
        var savedConnection: string = fs.readFileSync(configFilePath, { encoding: "utf8" });
        var connectionInfo: ILegacyLoginConnectionInfo | ILoginConnectionInfo = JSON.parse(savedConnection);

        // If the connection info is in the legacy format, convert it to the modern format
        if ((<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName) {
            connectionInfo = <ILoginConnectionInfo>{
                accessKey: (<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName
            };
        }

        return <ILoginConnectionInfo>connectionInfo;
    } catch (ex) {
        return;
    }
}

export function execute(command: cli.ICommand): Promise<void> {
    connectionInfo = deserializeConnectionInfo();

    return Q(<void>null)
        .then(() => {
            switch (command.type) {
                case cli.CommandType.login:
                case cli.CommandType.register:
                    if (connectionInfo) {
                        throw new Error("You are already logged in from this machine.");
                    }
                    break;

                default:
                    if (!!sdk) break; // Used by unit tests to skip authentication

                    if (!connectionInfo) {
                        throw new Error("You are not currently logged in. Run the 'code-push login' command to authenticate with the CodePush server.");
                    }

                    sdk = new AccountManager(connectionInfo.accessKey, CLI_HEADERS, connectionInfo.customServerUrl);
                    break;
            }

            switch (command.type) {
                case cli.CommandType.accessKeyAdd:
                    return accessKeyAdd(<cli.IAccessKeyAddCommand>command);

                case cli.CommandType.accessKeyList:
                    return accessKeyList(<cli.IAccessKeyListCommand>command);

                case cli.CommandType.accessKeyRemove:
                    return accessKeyRemove(<cli.IAccessKeyRemoveCommand>command);

                case cli.CommandType.appAdd:
                    return appAdd(<cli.IAppAddCommand>command);

                case cli.CommandType.appList:
                    return appList(<cli.IAppListCommand>command);

                case cli.CommandType.appRemove:
                    return appRemove(<cli.IAppRemoveCommand>command);

                case cli.CommandType.appRename:
                    return appRename(<cli.IAppRenameCommand>command);

                case cli.CommandType.appTransfer:
                    return appTransfer(<cli.IAppTransferCommand>command);

                case cli.CommandType.collaboratorAdd:
                    return addCollaborator(<cli.ICollaboratorAddCommand>command);

                case cli.CommandType.collaboratorList:
                    return listCollaborators(<cli.ICollaboratorListCommand>command);

                case cli.CommandType.collaboratorRemove:
                    return removeCollaborator(<cli.ICollaboratorRemoveCommand>command);

                case cli.CommandType.deploymentAdd:
                    return deploymentAdd(<cli.IDeploymentAddCommand>command);

                case cli.CommandType.deploymentHistoryClear:
                    return deploymentHistoryClear(<cli.IDeploymentHistoryClearCommand>command);

                case cli.CommandType.deploymentHistory:
                    return deploymentHistory(<cli.IDeploymentHistoryCommand>command);

                case cli.CommandType.deploymentList:
                    return deploymentList(<cli.IDeploymentListCommand>command);

                case cli.CommandType.deploymentRemove:
                    return deploymentRemove(<cli.IDeploymentRemoveCommand>command);

                case cli.CommandType.deploymentRename:
                    return deploymentRename(<cli.IDeploymentRenameCommand>command);

                case cli.CommandType.login:
                    return login(<cli.ILoginCommand>command);

                case cli.CommandType.logout:
                    return logout(command);

                case cli.CommandType.promote:
                    return promote(<cli.IPromoteCommand>command);

                case cli.CommandType.register:
                    return register(<cli.IRegisterCommand>command);

                case cli.CommandType.release:
                    return release(<cli.IReleaseCommand>command);

                case cli.CommandType.releaseCordova:
                    return releaseCordova(<cli.IReleaseCordovaCommand>command);

                case cli.CommandType.releaseReact:
                    return releaseReact(<cli.IReleaseReactCommand>command);

                case cli.CommandType.rollback:
                    return rollback(<cli.IRollbackCommand>command);

                default:
                    // We should never see this message as invalid commands should be caught by the argument parser.
                    throw new Error("Invalid command:  " + JSON.stringify(command));
            }
        });
}

function fileDoesNotExistOrIsDirectory(filePath: string): boolean {
    try {
        return fs.lstatSync(filePath).isDirectory();
    } catch (error) {
        return true;
    }
}

function generateRandomFilename(length: number): string {
    var filename: string = "";
    var validChar: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (var i = 0; i < length; i++) {
        filename += validChar.charAt(Math.floor(Math.random() * validChar.length));
    }

    return filename;
}

function getTotalActiveFromDeploymentMetrics(metrics: DeploymentMetrics): number {
    var totalActive = 0;
    Object.keys(metrics).forEach((label: string) => {
        totalActive += metrics[label].active;
    });

    return totalActive;
}

function initiateExternalAuthenticationAsync(action: string, serverUrl?: string): void {
    var message: string = `A browser is being launched to authenticate your account. Follow the instructions ` +
        `it displays to complete your ${action === "register" ? "registration" : "login"}.\r\n`;

    log(message);
    var hostname: string = os.hostname();
    var url: string = `${serverUrl || AccountManager.SERVER_URL}/auth/${action}?hostname=${hostname}`;
    opener(url);
}

function login(command: cli.ILoginCommand): Promise<void> {
    // Check if one of the flags were provided.
    if (command.accessKey) {
        sdk = new AccountManager(command.accessKey, CLI_HEADERS, command.serverUrl);
        return sdk.isAuthenticated()
            .then((isAuthenticated: boolean): void => {
                if (isAuthenticated) {
                    serializeConnectionInfo(command.accessKey, /*preserveAccessKeyOnLogout*/ true, command.serverUrl);
                } else {
                    throw new Error("Invalid access key.");
                }
            });
    } else {
        return loginWithExternalAuthentication("login", command.serverUrl);
    }
}

function loginWithExternalAuthentication(action: string, serverUrl?: string): Promise<void> {
    initiateExternalAuthenticationAsync(action, serverUrl);

    return requestAccessKey()
        .then((accessKey: string): Promise<void> => {
            if (accessKey === null) {
                // The user has aborted the synchronous prompt (e.g.:  via [CTRL]+[C]).
                return;
            }

            sdk = new AccountManager(accessKey, CLI_HEADERS, serverUrl);

            return sdk.isAuthenticated()
                .then((isAuthenticated: boolean): void => {
                    if (isAuthenticated) {
                        serializeConnectionInfo(accessKey, /*preserveAccessKeyOnLogout*/ false, serverUrl);
                    } else {
                        throw new Error("Invalid access key.");
                    }
                });
        });
}

function logout(command: cli.ICommand): Promise<void> {
    return Q(<void>null)
        .then((): Promise<void> => {
            if (!connectionInfo.preserveAccessKeyOnLogout) {
                return sdk.removeAccessKey(sdk.accessKey)
                    .then((): void => {
                        log(`Removed access key ${sdk.accessKey}.`);
                    });
            }
        })
        .finally((): void => {
            sdk = null;
            deleteConnectionInfoCache();
        });
}

function formatDate(unixOffset: number): string {
    var date: moment.Moment = moment(unixOffset);
    var now: moment.Moment = moment();
    if (now.diff(date, "days") < 30) {
        return date.fromNow();                  // "2 hours ago"
    } else if (now.year() === date.year()) {
        return date.format("MMM D");            // "Nov 6"
    } else {
        return date.format("MMM D, YYYY");      // "Nov 6, 2014"
    }
}

function printAppList(format: string, apps: App[], deploymentLists: string[][]): void {
    if (format === "json") {
        var dataSource: any[] = apps.map((app: App, index: number) => {
            var augmentedApp: any = app;
            augmentedApp.deployments = deploymentLists[index];
            return augmentedApp;
        });

        printJson(dataSource);
    } else if (format === "table") {
        var headers = ["Name", "Deployments"];
        printTable(headers, (dataSource: any[]): void => {
            apps.forEach((app: App, index: number): void => {
                var row = [app.name, wordwrap(50)(deploymentLists[index].join(", "))];
                dataSource.push(row);
            });
        });
    }
}

function getCollaboratorDisplayName(email: string, collaboratorProperties: CollaboratorProperties): string {
    return (collaboratorProperties.permission === AccountManager.AppPermission.OWNER) ? email + chalk.magenta(" (Owner)") : email;
}

function printCollaboratorsList(format: string, collaborators: CollaboratorMap): void {
    if (format === "json") {
        var dataSource = { "collaborators": collaborators };
        printJson(dataSource);
    } else if (format === "table") {
        var headers = ["E-mail Address"];
        printTable(headers, (dataSource: any[]): void => {
            Object.keys(collaborators).forEach((email: string): void => {
                var row = [getCollaboratorDisplayName(email, collaborators[email])];
                dataSource.push(row);
            });
        });
    }
}

function printDeploymentList(command: cli.IDeploymentListCommand, deployments: Deployment[], showPackage: boolean = true): void {
    if (command.format === "json") {
        printJson(deployments);
    } else if (command.format === "table") {
        var headers = ["Name"];
        if (command.displayKeys) {
            headers.push("Deployment Key");
        }

        if (showPackage) {
            headers.push("Update Metadata");
            headers.push("Install Metrics");
        }

        printTable(headers, (dataSource: any[]): void => {
            deployments.forEach((deployment: Deployment): void => {
                var row = [deployment.name];
                if (command.displayKeys) {
                    row.push(deployment.key);
                }

                if (showPackage) {
                    row.push(getPackageString(deployment.package));
                    row.push(getPackageMetricsString(<PackageWithMetrics>(deployment.package)));
                }

                dataSource.push(row);
            });
        });
    }
}

function printDeploymentHistory(command: cli.IDeploymentHistoryCommand, deploymentHistory: PackageWithMetrics[], currentUserEmail: string): void {
    if (command.format === "json") {
        printJson(deploymentHistory);
    } else if (command.format === "table") {
        var headers = ["Label", "Release Time", "App Version", "Mandatory"];
        if (command.displayAuthor) {
            headers.push("Released By");
        }

        headers.push("Description", "Install Metrics");

        printTable(headers, (dataSource: any[]) => {
            deploymentHistory.forEach((packageObject: Package) => {
                var releaseTime: string = formatDate(packageObject.uploadTime);
                var releaseSource: string;
                if (packageObject.releaseMethod === "Promote") {
                    releaseSource = `Promoted ${packageObject.originalLabel} from "${packageObject.originalDeployment}"`;
                } else if (packageObject.releaseMethod === "Rollback") {
                    var labelNumber: number = parseInt(packageObject.label.substring(1));
                    var lastLabel: string = "v" + (labelNumber - 1);
                    releaseSource = `Rolled back ${lastLabel} to ${packageObject.originalLabel}`;
                }

                if (releaseSource) {
                    releaseTime += "\n" + chalk.magenta(`(${releaseSource})`).toString();
                }

                var row = [packageObject.label, releaseTime, packageObject.appVersion, packageObject.isMandatory ? "Yes" : "No"];
                if (command.displayAuthor) {
                    var releasedBy: string = packageObject.releasedBy ? packageObject.releasedBy : "";
                    if (currentUserEmail && releasedBy === currentUserEmail) {
                        releasedBy = "You";
                    }

                    row.push(releasedBy);
                }

                row.push(packageObject.description ? wordwrap(30)(packageObject.description) : "", getPackageMetricsString(packageObject));

                dataSource.push(row);
            });
        });
    }
}

function getPackageString(packageObject: Package): string {
    if (!packageObject) {
        return chalk.magenta("No updates released").toString();
    }

    return chalk.green("Label: ") + packageObject.label + "\n" +
        chalk.green("App Version: ") + packageObject.appVersion + "\n" +
        chalk.green("Mandatory: ") + (packageObject.isMandatory ? "Yes" : "No") + "\n" +
        chalk.green("Release Time: ") + formatDate(packageObject.uploadTime) + "\n" +
        chalk.green("Released By: ") + (packageObject.releasedBy ? packageObject.releasedBy : "") +
        (packageObject.description ? wordwrap(70)("\n" + chalk.green("Description: ") + packageObject.description) : "");
}

function getPackageMetricsString(packageObject: PackageWithMetrics): string {
    if (!packageObject || !packageObject.metrics) {
        return "" + chalk.magenta("No installs recorded");
    }

    var activePercent: number = packageObject.metrics.totalActive
        ? packageObject.metrics.active / packageObject.metrics.totalActive * 100
        : 0.0;
    var percentString: string;
    if (activePercent === 100.0) {
        percentString = "100%";
    } else if (activePercent === 0.0) {
        percentString = "0%";
    } else {
        percentString = activePercent.toPrecision(2) + "%";
    }

    var numPending: number = packageObject.metrics.downloaded - packageObject.metrics.installed - packageObject.metrics.failed;
    var returnString: string = chalk.green("Active: ") + percentString + " (" + packageObject.metrics.active.toLocaleString() + " of " + packageObject.metrics.totalActive.toLocaleString() + ")\n" +
        chalk.green("Total: ") + packageObject.metrics.installed.toLocaleString();

    if (numPending > 0) {
        returnString += " (" + numPending.toLocaleString() + " pending)";
    }

    if (packageObject.metrics.failed) {
        returnString += "\n" + chalk.green("Rollbacks: ") + chalk.red(packageObject.metrics.failed.toLocaleString() + "");
    }

    return returnString;
}

function getReactNativeProjectAppVersion(platform: string, projectName: string): Promise<string> {
    var missingPatchVersionRegex: RegExp = /^\d+\.\d+$/;
    if (platform === "ios") {
        try {
            var infoPlistContainingFolder: string = path.join("iOS", projectName);
            var infoPlistContents: string = fs.readFileSync(path.join(infoPlistContainingFolder, "Info.plist")).toString();
        } catch (err) {
            try {
                infoPlistContainingFolder = "iOS";
                infoPlistContents = fs.readFileSync(path.join(infoPlistContainingFolder, "Info.plist")).toString();
            } catch (err) {
                throw new Error(`Unable to find or read "Info.plist" in the "iOS/${projectName}" or "iOS" folders.`);
            }
        }

        try {
            var parsedInfoPlist: any = plist.parse(infoPlistContents);
        } catch (err) {
            throw new Error(`Unable to parse the "${infoPlistContainingFolder}/Info.plist" file, it could be malformed.`);
        }

        if (parsedInfoPlist && parsedInfoPlist.CFBundleShortVersionString) {
            if (semver.valid(parsedInfoPlist.CFBundleShortVersionString) || missingPatchVersionRegex.test(parsedInfoPlist.CFBundleShortVersionString)) {
                return Q(parsedInfoPlist.CFBundleShortVersionString);
            } else {
                throw new Error(`The "CFBundleShortVersionString" key in "${infoPlistContainingFolder}/Info.plist" needs to have at least a major and minor version, for example "2.0" or "1.0.3".`);
            }
        } else {
            throw new Error(`The "CFBundleShortVersionString" key does not exist in "${infoPlistContainingFolder}/Info.plist".`);
        }
    } else {
        var buildGradlePath: string = path.join("android", "app", "build.gradle");
        if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
            throw new Error("Unable to find or read \"build.gradle\" in the \"android/app\" folder.");
        }

        return g2js.parseFile(buildGradlePath)
            .catch((err: Error) => {
                throw new Error("Unable to parse the \"android/app/build.gradle\" file, it could be malformed.");
            })
            .then((buildGradle: any) => {
                if (buildGradle.android && buildGradle.android.defaultConfig && buildGradle.android.defaultConfig.versionName) {
                    var appVersion: string = buildGradle.android.defaultConfig.versionName.replace(/"/g, "").trim();
                    if (semver.valid(appVersion) || missingPatchVersionRegex.test(appVersion)) {
                        return appVersion;
                    } else {
                        throw new Error("The \"android.defaultConfig.versionName\" property in \"android/app/build.gradle\" needs to have at least a major and minor version, for example \"2.0\" or \"1.0.3\".");
                    }
                } else {
                    throw new Error("The \"android/app/build.gradle\" file does not include a value for android.defaultConfig.versionName.");
                }
            });
    }
}

function printJson(object: any): void {
    log(JSON.stringify(object, /*replacer=*/ null, /*spacing=*/ 2));
}

function printAccessKeys(format: string, keys: AccessKey[]): void {
    if (format === "json") {
        printJson(keys);
    } else if (format === "table") {
        printTable(["Key", "Time Created", "Created From", "Description"], (dataSource: any[]): void => {
            keys.forEach((key: AccessKey): void => {
                dataSource.push([
                    key.name,
                    key.createdTime ? formatDate(key.createdTime) : "",
                    key.createdBy ? key.createdBy : "",
                    key.description ? key.description : ""
                ]);
            });
        });
    }
}

function printTable(columnNames: string[], readData: (dataSource: any[]) => void): void {
    var table = new Table({
        head: columnNames,
        style: { head: ["cyan"] }
    });

    readData(table);

    log(table.toString());
}

function register(command: cli.IRegisterCommand): Promise<void> {
    return loginWithExternalAuthentication("register", command.serverUrl);
}

function promote(command: cli.IPromoteCommand): Promise<void> {
    return sdk.promote(command.appName, command.sourceDeploymentName, command.destDeploymentName)
        .then((): void => {
            log("Successfully promoted the \"" + command.sourceDeploymentName + "\" deployment of the \"" + command.appName + "\" app to the \"" + command.destDeploymentName + "\" deployment.");
        });
}

export var release = (command: cli.IReleaseCommand): Promise<void> => {
    if (isBinaryOrZip(command.package)) {
        throw new Error("It is unnecessary to package releases in a .zip or binary file. Please specify the direct path to the update content's directory (e.g. /platforms/ios/www) or file (e.g. main.jsbundle).");
    }

    throwForInvalidSemverRange(command.appStoreVersion);
    var filePath: string = command.package;
    var getPackageFilePromise: Promise<IPackageFile>;
    var isSingleFilePackage: boolean = true;

    if (fs.lstatSync(filePath).isDirectory()) {
        isSingleFilePackage = false;
        getPackageFilePromise = Promise<IPackageFile>((resolve: (file: IPackageFile) => void, reject: (reason: Error) => void): void => {
            var directoryPath: string = filePath;

            recursiveFs.readdirr(directoryPath, (error?: any, directories?: string[], files?: string[]): void => {
                if (error) {
                    reject(error);
                    return;
                }

                var baseDirectoryPath = path.dirname(directoryPath);
                var fileName: string = generateRandomFilename(15) + ".zip";
                var zipFile = new yazl.ZipFile();
                var writeStream: fs.WriteStream = fs.createWriteStream(fileName);

                zipFile.outputStream.pipe(writeStream)
                    .on("error", (error: Error): void => {
                        reject(error);
                    })
                    .on("close", (): void => {
                        filePath = path.join(process.cwd(), fileName);

                        resolve({ isTemporary: true, path: filePath });
                    });

                for (var i = 0; i < files.length; ++i) {
                    var file: string = files[i];
                    var relativePath: string = path.relative(baseDirectoryPath, file);

                    // yazl does not like backslash (\) in the metadata path.
                    relativePath = slash(relativePath);

                    zipFile.addFile(file, relativePath);
                }

                zipFile.end();
            });
        });
    } else {
        getPackageFilePromise = Q({ isTemporary: false, path: filePath });
    }

    var lastTotalProgress = 0;
    var progressBar = new progress("Upload progress:[:bar] :percent :etas", {
        complete: "=",
        incomplete: " ",
        width: 50,
        total: 100
    });

    var uploadProgress = (currentProgress: number): void => {
        progressBar.tick(currentProgress - lastTotalProgress);
        lastTotalProgress = currentProgress;
    };

    return getPackageFilePromise
        .then((file: IPackageFile): Promise<void> => {
            return sdk.release(command.appName, command.deploymentName, file.path, command.appStoreVersion, command.description, command.mandatory, uploadProgress)
                .then((): void => {
                    log("Successfully released an update containing the \"" + command.package + "\" " + (isSingleFilePackage ? "file" : "directory") + " to the \"" + command.deploymentName + "\" deployment of the \"" + command.appName + "\" app.");
                })
                .finally((): void => {
                    if (file.isTemporary) {
                        fs.unlinkSync(filePath);
                    }
                });
        });
}

export var releaseCordova = (command: cli.IReleaseCordovaCommand): Promise<void> => {
    var platform: string = command.platform.toLowerCase();
    var projectRoot: string = process.cwd();
    var platformFolder: string = path.join(projectRoot, "platforms", platform);
    var platformCordova: string = path.join(platformFolder, "cordova");
    var outputFolder: string;
    var preparePromise: Promise<void>;

    if (platform === "ios") {
        outputFolder = path.join(platformFolder, "www");
    } else if (platform === "android") {
        outputFolder = path.join(platformFolder, "assets", "www");
    } else {
        throw new Error("Platform must be either \"ios\" or \"android\".");
    }

    try {
        var prepareProcess: any = spawnSync("cordova", ["prepare", platform]);
        if (prepareProcess.error) {
            throw prepareProcess.error;
        }
    } catch (error) {
        if (error.code == "ENOENT") {
            throw new Error(`Failed to call "cordova prepare". Please ensure that the Cordova CLI is installed.`);
        }

        throw new Error(`Unable to prepare project. Please ensure that this is a Cordova project and that platform "${platform}" was added with "cordova platform add ${platform}"`);
    }

    try {
        var configString: string = fs.readFileSync(path.join(projectRoot, "config.xml"), { encoding: "utf8" });
    } catch (error) {
        throw new Error(`Unable to find or read "config.xml" in the CWD. The "release-cordova" command must be executed in a Cordova project folder.`);
    }

    var configPromise: Promise<any> = parseXml(configString);
    var releaseCommand: cli.IReleaseCommand = <any>command;

    releaseCommand.package = outputFolder;
    releaseCommand.type = cli.CommandType.release;

    return configPromise
        .catch((err: any) => {
            throw new Error(`Unable to parse "config.xml" in the CWD. Ensure that the contents of "config.xml" is valid XML.`);
        })
        .then((parsedConfig: any) => {
            var config: any = parsedConfig.widget;

            var releaseTargetVersion: string;
            if (command.appStoreVersion) {
                releaseTargetVersion = command.appStoreVersion;
            } else {
                releaseTargetVersion = config["$"].version;
            }

            throwForInvalidSemverRange(releaseTargetVersion);
            releaseCommand.appStoreVersion = releaseTargetVersion;

            log(chalk.cyan("\nReleasing update contents to CodePush:\n"));
            return release(releaseCommand);
        });
}

export var releaseReact = (command: cli.IReleaseReactCommand): Promise<void> => {
    var bundleName: string = command.bundleName;
    var entryFile: string = command.entryFile;
    var outputFolder: string = path.join(os.tmpdir(), "CodePush");
    var platform: string = command.platform.toLowerCase();
    var releaseCommand: cli.IReleaseCommand = <any>command;
    releaseCommand.package = outputFolder;

    if (platform === "ios") {
        if (!bundleName) {
            bundleName = "main.jsbundle";
        }
    } else if (platform === "android") {
        if (!bundleName) {
            bundleName = "index.android.bundle";
        }
    } else {
        throw new Error("Platform must be either \"ios\" or \"android\".");
    }

    try {
        var projectPackageJson: any = require(path.join(process.cwd(), "package.json"));
        var projectName: string = projectPackageJson.name;
        if (!projectName) {
            throw new Error("The \"package.json\" file in the CWD does not have the \"name\" field set.");
        }

        if (!projectPackageJson.dependencies["react-native"]) {
            throw new Error("The project in the CWD is not a React Native project.");
        }
    } catch (error) {
        throw new Error("Unable to find or read \"package.json\" in the CWD. The \"release-react\" command must be executed in a React Native project folder.");
    }

    if (!entryFile) {
        entryFile = `index.${platform}.js`;
        if (fileDoesNotExistOrIsDirectory(entryFile)) {
            entryFile = "index.js";
        }

        if (fileDoesNotExistOrIsDirectory(entryFile)) {
            throw new Error(`Entry file "index.${platform}.js" or "index.js" does not exist.`);
        }
    } else {
        if (fileDoesNotExistOrIsDirectory(entryFile)) {
            throw new Error(`Entry file "${entryFile}" does not exist.`);
        }
    }

    if (command.appStoreVersion) {
        throwForInvalidSemverRange(command.appStoreVersion);
    }

    var appVersionPromise: Promise<string> = command.appStoreVersion
        ? Q(command.appStoreVersion)
        : getReactNativeProjectAppVersion(platform, projectName);

    return appVersionPromise
        .then((appVersion: string) => {
            releaseCommand.appStoreVersion = appVersion;
            return createEmptyTempReleaseFolder(outputFolder);
        })
        // This is needed to clear the react native bundler cache:
        // https://github.com/facebook/react-native/issues/4289
        .then(() => deleteFolder(`${os.tmpdir()}/react-*`))
        .then(() => runReactNativeBundleCommand(bundleName, command.development || false, entryFile, outputFolder, platform, command.sourcemapOutput))
        .then(() => {
            log(chalk.cyan("\nReleasing update contents to CodePush:\n"));
            return release(releaseCommand);
        })
        .then(() => deleteFolder(outputFolder))
        .catch((err: Error) => {
            deleteFolder(outputFolder);
            throw err;
        });
}

function rollback(command: cli.IRollbackCommand): Promise<void> {
    return confirm()
        .then((wasConfirmed: boolean) => {
            if (!wasConfirmed) {
                log("Rollback cancelled.")
                return;
            }

            return sdk.rollback(command.appName, command.deploymentName, command.targetRelease || undefined)
                .then((): void => {
                    log("Successfully performed a rollback on the \"" + command.deploymentName + "\" deployment of the \"" + command.appName + "\" app.");
                });
        });
}

function requestAccessKey(): Promise<string> {
    return Promise<string>((resolve, reject, notify): void => {
        prompt.message = "";
        prompt.delimiter = "";

        prompt.start();

        prompt.get({
            properties: {
                response: {
                    description: chalk.cyan("Enter your access key: ")
                }
            }
        }, (err: any, result: any): void => {
            if (err) {
                resolve(null);
            } else {
                resolve(result.response.trim());
            }
        });
    });
}

export var runReactNativeBundleCommand = (bundleName: string, development: boolean, entryFile: string, outputFolder: string, platform: string, sourcemapOutput: string): Promise<void> => {
    var reactNativeBundleArgs = [
        path.join("node_modules", "react-native", "local-cli", "cli.js"), "bundle",
        "--assets-dest", outputFolder,
        "--bundle-output", path.join(outputFolder, bundleName),
        "--dev", development,
        "--entry-file", entryFile,
        "--platform", platform,
    ];

    if (sourcemapOutput) {
        reactNativeBundleArgs.push("--sourcemap-output", sourcemapOutput);
    }

    log(chalk.cyan("Running \"react-native bundle\" command:\n"));
    var reactNativeBundleProcess = spawn("node", reactNativeBundleArgs);
    log(`node ${reactNativeBundleArgs.join(" ")}`);

    return Promise<void>((resolve, reject, notify) => {
        reactNativeBundleProcess.stdout.on("data", (data: Buffer) => {
            log(data.toString().trim());
        });

        reactNativeBundleProcess.stderr.on("data", (data: Buffer) => {
            console.error(data.toString().trim());
        });

        reactNativeBundleProcess.on("close", (exitCode: number) => {
            if (exitCode) {
                reject(new Error(`"react-native bundle" command exited with code ${exitCode}.`));
            }

            resolve(<void>null);
        });
    });
}

function serializeConnectionInfo(accessKey: string, preserveAccessKeyOnLogout: boolean, customServerUrl?: string): void {
    var connectionInfo: ILoginConnectionInfo = { accessKey: accessKey, preserveAccessKeyOnLogout: preserveAccessKeyOnLogout };
    if (customServerUrl) {
        connectionInfo.customServerUrl = customServerUrl;
    }

    var json: string = JSON.stringify(connectionInfo);
    fs.writeFileSync(configFilePath, json, { encoding: "utf8" });

    log(`\r\nSuccessfully logged-in. Your session file was written to ${chalk.cyan(configFilePath)}. You can run the ${chalk.cyan("code-push logout")} command at any time to delete this file and terminate your session.\r\n`);
}

function isBinaryOrZip(path: string): boolean {
    return path.search(/\.zip$/i) !== -1
        || path.search(/\.apk$/i) !== -1
        || path.search(/\.ipa$/i) !== -1;
}

function throwForInvalidEmail(email: string): void {
    if (!emailValidator.validate(email)) {
        throw new Error("\"" + email + "\" is an invalid e-mail address.");
    }
}

function throwForInvalidSemverRange(semverRange: string): void {
    if (semver.validRange(semverRange) === null) {
        throw new Error("Please use a semver-compliant target binary version range, for example \"1.0.0\", \"*\" or \"^1.2.3\".");
    }
}

function throwForInvalidOutputFormat(format: string): void {
    switch (format) {
        case "json":
        case "table":
            break;

        default:
            throw new Error("Invalid format:  " + format + ".");
    }
}
