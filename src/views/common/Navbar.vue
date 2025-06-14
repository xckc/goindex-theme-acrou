<template>
  <el-menu mode="horizontal">
    <el-row type="flex" justify="space-between">
      <el-col :span="12" class="nav-left">
        <el-menu-item @click="go(-1)" v-if="history.length > 1">
          <i class="el-icon-arrow-left"></i>
        </el-menu-item>
        <el-menu-item>
          <BreadCrumb />
        </el-menu-item>
      </el-col>
      <el-col :span="12" class="nav-right">
        <!-- 清理缓存按钮 -->
        <el-tooltip
          v-if="isAdmin"
          effect="dark"
          :content="$t('setting.clearCache.title')"
          placement="bottom"
        >
          <el-button
            class="hidden-xs-only"
            type="danger"
            icon="el-icon-delete"
            circle
            @click="handleClearCache"
            :loading="clearing"
          ></el-button>
        </el-tooltip>
        <!-- 视图模式切换 -->
        <ViewMode />
      </el-col>
    </el-row>
  </el-menu>
</template>

<script>
import { mapState } from "vuex";
import BreadCrumb from "@/views/common/BreadCrumb";
import ViewMode from "@/layout/viewmode";

export default {
  name: "Navbar",
  components: { BreadCrumb, ViewMode },
  data() {
    return {
      history: [],
      isAdmin: false,
      clearing: false,
    };
  },
  computed: {
    ...mapState("acrou/history", ["history"]),
  },
  mounted() {
    this.history = this.$store.state.acrou.history.history;
    // 检查由 worker/config.js 注入的配置
    if (window.config && window.config.cacheClearEnabled) {
      this.isAdmin = true;
    }
  },
  methods: {
    go(his) {
      this.$router.go(his);
    },
    handleClearCache() {
      this.$prompt(
        this.$t('setting.clearCache.prompt'), 
        this.$t('setting.clearCache.title'), {
        confirmButtonText: this.$t('common.ok'),
        cancelButtonText: this.$t('common.cancel'),
        inputType: 'password',
      }).then(async ({ value }) => {
        if (!value) {
          this.$message({
            type: 'warning',
            message: this.$t('setting.clearCache.secretRequired')
          });
          return;
        }

        this.clearing = true;
        try {
          const resp = await this.$http.post("/api/clearcache", {
            admin_pass: value,
          });
          this.$message.success(resp.data.message);
          setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
          const message = e.response ? e.response.data.message : e.message;
          this.$message.error(message || "Request Failed");
        } finally {
          this.clearing = false;
        }
      }).catch(() => {
        // 用户取消输入
      });
    },
  },
};
</script>

<style lang="scss" scoped>
.nav-left {
  display: flex;
  align-items: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  .el-button {
    margin-right: 10px;
  }
}
</style>

