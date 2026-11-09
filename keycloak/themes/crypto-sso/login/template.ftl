<#--
  통합 인증 화면 틀. base 테마의 template.ftl 에서 동작에 필요한 스크립트(세션 확인, 버튼 중복 클릭 방지)는 그대로 두고
  레이아웃만 새로 짰다. 로그인 폼 자체는 base 테마의 login.ftl 이 이 틀 안에 들어온다.
-->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<#assign clientKey = (client.clientId)!"" >
<#assign clientRawName = (client.name)!"" >
<#assign clientName = clientRawName?has_content?then(advancedMsg(clientRawName), clientKey) >
<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${msg("ssoBrand")}</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='12' cy='16' r='8' fill='none' stroke='%232f6b52' stroke-width='3'/%3E%3Ccircle cx='20' cy='16' r='8' fill='none' stroke='%232f4fa8' stroke-width='3'/%3E%3C/svg%3E">
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <script type="importmap">
        { "imports": { "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js" } }
    </script>
    <script src="${url.resourcesPath}/js/menu-button-links.js" type="module"></script>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module">
        <#outputformat "JavaScript">
        import { startSessionPolling } from ${(url.resourcesPath + "/js/authChecker.js")?c};
        startSessionPolling(${url.ssoLoginInOtherTabsUrl?c});
        </#outputformat>
    </script>
    <script type="module">
        document.addEventListener("click", (event) => {
            const link = event.target.closest("a[data-once-link]");
            if (!link) return;
            if (link.getAttribute("aria-disabled") === "true") { event.preventDefault(); return; }
            const { disabledClass } = link.dataset;
            if (disabledClass) link.classList.add(...disabledClass.trim().split(/\s+/));
            link.setAttribute("role", "link");
            link.setAttribute("aria-disabled", "true");
        });
    </script>
    <#if authenticationSession??>
        <script type="module">
            <#outputformat "JavaScript">
            import { checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};
            checkAuthSession(${authenticationSession.authSessionIdHash?c});
            </#outputformat>
        </script>
    </#if>
</head>

<body class="${properties.kcBodyClass!} ${bodyClass}" data-page-id="login-${pageId}" data-client="${clientKey}">
<main class="${properties.kcLoginClass!}">

    <header class="sso-brand">
        <svg class="sso-mark" viewBox="0 0 48 32" aria-hidden="true">
            <circle class="ring-a" cx="17" cy="16" r="12"/>
            <circle class="ring-b" cx="31" cy="16" r="12"/>
        </svg>
        <div>
            <div class="sso-brand-name">${msg("ssoBrand")}</div>
            <div class="sso-brand-sub">Identity Provider · Keycloak</div>
        </div>
    </header>

    <section class="${properties.kcFormCardClass!}" aria-labelledby="kc-page-title">
        <#if clientName?has_content>
            <p class="sso-requested">
                <span class="sso-dot" aria-hidden="true"></span>
                ${msg("ssoRequestedBy", clientName)}
            </p>
        </#if>

        <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
            <h1 id="kc-page-title" class="sso-title"><#nested "header"></h1>
        <#else>
            <h1 id="kc-page-title" class="sso-title"><#nested "header"></h1>
            <#nested "show-username">
            <div id="kc-username" class="sso-attempted">
                <span id="kc-attempted-username">${auth.attemptedUsername}</span>
                <a id="reset-login" href="${url.loginRestartFlowUrl}">${msg("restartLoginTooltip")}</a>
            </div>
        </#if>

        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <div class="${properties.kcAlertClass!} sso-alert-${message.type}" role="alert">
                <span class="${properties.kcAlertTitleClass!}">${kcSanitize(message.summary)?no_esc}</span>
            </div>
        </#if>

        <#nested "form">

        <#if auth?has_content && auth.showTryAnotherWayLink()>
            <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
                <input type="hidden" name="tryAnotherWay" value="on"/>
                <a href="#" id="try-another-way" class="sso-link"
                   onclick="document.forms['kc-select-try-another-way-form'].requestSubmit();return false;">${msg("doTryAnotherWay")}</a>
            </form>
        </#if>

        <#nested "socialProviders">

        <#if displayInfo>
            <div id="kc-info" class="${properties.kcSignUpClass!}">
                <#nested "info">
            </div>
        </#if>
    </section>

    <aside class="sso-explain">
        <p class="sso-shared">
            <span class="sso-chip sso-chip-a">서명 발급소</span>
            <span class="sso-chip sso-chip-b">서명 검증소</span>
        </p>
        <p>${msg("ssoShared")}</p>
        <p class="sso-tech">${msg("ssoTech")}</p>
    </aside>

    <footer class="sso-footer">${msg("ssoFooter")}</footer>
</main>
</body>
</html>
</#macro>
