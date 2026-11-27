-- Red Book for the GL.iNet admin panel (luci-app-redbook).
-- The panel checks every string argument against a default pattern (only
-- letters, digits and " .-_:#/") unless this file says otherwise. Methods
-- marked true check their own arguments (/usr/lib/oui-httpd/rpc/redbook),
-- so a secret or setting may hold any character.
-- SPDX-License-Identifier: MIT
return { set_config = true, set_secret = true }
