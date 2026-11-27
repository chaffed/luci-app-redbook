-- Red Book for the GL.iNet admin panel (luci-app-redbook).
-- The panel checks every string argument against a default pattern (only
-- letters, digits and " .-_:#/") unless this file says otherwise. Methods
-- marked true check their own arguments (/usr/lib/oui-httpd/rpc/redbook):
-- a password may hold any character, a share name a "$", and the text to
-- look for in the log lines any punctuation.
-- SPDX-License-Identifier: MIT
return { set_config = true, set_secret = true, get_lines = true }
