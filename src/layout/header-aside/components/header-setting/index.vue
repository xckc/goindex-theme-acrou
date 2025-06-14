<template>
  <div class="navbar-item has-dropdown is-hoverable">
    <a class="navbar-link is-arrowless" title="Setting">
      <i class="fa fa-cog" aria-hidden="true"></i>
    </a>
    <div class="navbar-dropdown is-left">
      <!-- 原有的清理本地缓存按钮 -->
      <a class="navbar-item" @click="cleanCache">
        <span class="icon">
          <i class="fa fa-trash" aria-hidden="true"></i>
        </span>
        {{ $t("setting.clear.text") }}
      </a>
      <!-- 新增的清理服务器缓存按钮 -->
      <a v-if="isAdminPassSet" class="navbar-item" @click="cleanServerCache">
        <span class="icon">
          <i class="fa fa-server" aria-hidden="true"></i>
        </span>
        <span>清理服务器缓存</span>
      </a>
    </div>
  </div>
</template>

<script>
import { mapActions } from "vuex";
import util from "@/libs/util";
export default {
  data() {
    return {
      // 新增数据属性，用于控制“清理服务器缓存”按钮的显示
      isAdminPassSet: false,
    };
  },
  // 新增生命周期钩子，在组件加载到页面后执行
  mounted() {
    // 从 Worker 注入的全局配置中读取 isAdminPassSet 的状态
    if (window.gdconfig && typeof window.gdconfig.isAdminPassSet !== 'undefined') {
      this.isAdminPassSet = window.gdconfig.isAdminPassSet;
    }
  },
  methods: {
    ...mapActions("acrou/db", ["databaseClear"]),
    // 原有的 cleanCache 方法保持不变
    cleanCache() {
      new Promise((resolve) => {
        Object.keys(localStorage).forEach((item) => {
          if (item.indexOf("file_path_") !== -1) {
            localStorage.removeItem(item);
          }
        });
        util.cookies.remove("lang");
        this.databaseClear();
        resolve();
      }).then(() => {
        this.$notify({
          title: this.$t("notify.title"),
          message: this.$t("setting.clear.success"),
          type: "success",
        });
      });
    },
    // 新增 cleanServerCache 方法，用于处理服务器缓存清理逻辑
    async cleanServerCache() {
      const password = prompt("[ADMIN] 请输入密码以清理服务器KV缓存：");
      if (!password) {
        this.$notify({
          title: "操作取消",
          message: "未输入密码，已取消操作。",
          type: "info",
        });
        return;
      }

      this.$notify({
        title: "请求已发送",
        message: "正在清理服务器缓存，请稍候...",
        type: "info",
      });

      try {
        const response = await fetch(`/${window.current_drive_order}:clearcache`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password })
        });
        const result = await response.json();

        if (response.ok && result.success) {
          this.$notify({
            title: "操作成功",
            message: `服务器清理成功: ${result.message}`,
            type: "success",
          });
        } else {
          this.$notify({
            title: "操作失败",
            message: `服务器清理失败: ${result.message || response.statusText}`,
            type: "error",
          });
        }
      } catch (e) {
         this.$notify({
            title: "请求错误",
            message: `无法连接到服务器: ${e.message}`,
            type: "error",
          });
      }
    }
  },
};
</script>

